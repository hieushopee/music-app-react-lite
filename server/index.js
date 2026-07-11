import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import YTMusic from 'ytmusic-api'
import lrclibApi from 'lrclib-api'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import youtubeDl from 'youtube-dl-exec'
import ffmpegPath from 'ffmpeg-static'

dotenv.config()

const app = express()
const port = process.env.PORT || 5174
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(serverDir, 'data')
const manualLyricsPath = path.join(dataDir, 'manual-lyrics.json')
const frontendDist = path.join(serverDir, '..', 'dist')
const cookieFile = path.join(serverDir, 'yt-cookies.txt')

// Write YouTube cookies from env var to disk (for cloud deployments)
async function initCookies() {
  const cookieContent = process.env.YT_COOKIES || ''
  if (cookieContent.trim()) {
    try {
      await fs.writeFile(cookieFile, cookieContent, 'utf-8')
      console.log('[cookies] YouTube cookie file written.')
    } catch (err) {
      console.warn('[cookies] Failed to write cookie file:', err.message)
    }
  }
}

// Returns extra yt-dlp options for cookie auth if cookie file exists
function cookieOpts() {
  const content = process.env.YT_COOKIES || ''
  if (!content.trim()) return {}
  return { cookies: cookieFile }
}

app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use(express.static(frontendDist))

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) {
    return next()
  }
  res.sendFile(path.join(frontendDist, 'index.html'))
})

const ytmusic = new YTMusic()
const { Client: LRCLibClient, parseLocalLyrics } = lrclibApi
const lrclib = new LRCLibClient()
let initPromise = null
let inMemoryStore = null
let writeTimeout = null

async function withTimeout(task, timeoutMs, fallbackValue) {
  let timer = null

  try {
    return await Promise.race([
      Promise.resolve().then(() => (typeof task === 'function' ? task() : task)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs)
      }),
    ])
  } catch {
    return fallbackValue
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function ensureYtMusic() {
  if (!initPromise) {
    initPromise = ytmusic.initialize({ GL: 'VN', HL: 'vi' })
  }
  return initPromise
}

async function ensureManualLyricsStore() {
  await fs.mkdir(dataDir, { recursive: true })

  try {
    await fs.access(manualLyricsPath)
  } catch {
    await fs.writeFile(manualLyricsPath, '{}', 'utf8')
  }
}

async function readManualLyricsStore() {
  await ensureManualLyricsStore()

  try {
    const raw = await fs.readFile(manualLyricsPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeManualLyricsStore(store) {
  await ensureManualLyricsStore()
  await fs.writeFile(manualLyricsPath, JSON.stringify(store, null, 2), 'utf8')
}

async function getManualLyricsStore() {
  if (inMemoryStore) return inMemoryStore
  inMemoryStore = await readManualLyricsStore()
  return inMemoryStore
}

function scheduleManualLyricsWrite() {
  if (writeTimeout) return
  writeTimeout = setTimeout(async () => {
    writeTimeout = null
    const storeToSave = inMemoryStore
    if (!storeToSave) return
    try {
      await writeManualLyricsStore(storeToSave)
    } catch (err) {
      console.error('Failed to save manual lyrics:', err)
    }
  }, 2000)
}

function pickThumb(thumbnails = []) {
  if (typeof thumbnails === 'string') return thumbnails
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return ''

  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))
  return sorted[0]?.url || ''
}

function upscaleThumbnail(url, videoId = '') {
  const input = String(url || '').trim()

  if (input.includes('googleusercontent.com')) {
    return input
      .replace(/=w\d+-h\d+(-[a-z0-9-]+)?/i, '=w1200-h1200-p-l90-rj')
      .replace(/=s\d+(-[a-z0-9-]+)?/i, '=s1200')
  }

  const id = String(videoId || '').trim()
  if (id && (!input || input.includes('ytimg.com'))) {
    // maxresdefault is highest quality; client should fallback to mqdefault if 404
    return `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
  }

  return input
}

function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0

  const input = value.trim()
  if (!input) return 0
  if (/^\d+$/.test(input)) return Number(input)

  const parts = input.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return 0

  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function normalizeLyricText(value) {
  return normalizeText(String(value || '').replace(/\([^)]*\)/g, ' '))
}

function scoreMatch(query, item) {
  const q = normalizeText(query)
  const text = normalizeText(`${item?.title || ''} ${item?.artist || ''} ${item?.album || ''}`)

  if (!q || !text) return 0
  if (text.includes(q)) return 120 + Math.min(60, q.length)

  const tokens = q.split(' ').filter((token) => token.length > 1)
  if (!tokens.length) return 0

  let hits = 0
  for (const token of tokens) {
    if (text.includes(token)) hits += 1
  }

  return Math.round((hits / tokens.length) * 100)
}

function scoreArtistMatch(query, artist) {
  const q = normalizeText(query)
  const name = normalizeText(artist?.name || '')

  if (!q || !name) return 0

  const compactQuery = q.replace(/\s+/g, '')
  const compactName = name.replace(/\s+/g, '')

  if (compactName === compactQuery) return 500
  if (name === q) return 480
  if (name.startsWith(q) || q.startsWith(name)) return 340
  if (name.includes(q) || q.includes(name)) return 260

  const queryTokens = q.split(' ').filter(Boolean)
  const nameTokens = name.split(' ').filter(Boolean)
  if (!queryTokens.length || !nameTokens.length) return 0

  let exactHits = 0
  let prefixHits = 0

  for (const token of queryTokens) {
    if (nameTokens.includes(token)) {
      exactHits += 1
      continue
    }

    if (nameTokens.some((part) => part.startsWith(token) || token.startsWith(part))) {
      prefixHits += 1
    }
  }

  const coverage = (exactHits + prefixHits * 0.6) / queryTokens.length
  const balanceBonus = Math.max(0, 40 - Math.abs(nameTokens.length - queryTokens.length) * 10)

  return Math.round(coverage * 180 + exactHits * 50 + prefixHits * 20 + balanceBonus)
}

function normalizeSong(song) {
  if (!song) return null

  const id = String(song.videoId || '').trim()
  if (!id) return null

  const artistName =
    song.artist?.name ||
    song.artist ||
    song.artists?.name ||
    song.artists ||
    song.artists?.[0]?.name ||
    song.author ||
    'Unknown artist'

  return {
    id,
    title: String(song.name || song.title || 'Unknown title'),
    artist: String(artistName),
    album: String(song.album?.name || artistName || 'YouTube Music'),
    duration: parseDuration(song.duration),
    thumbnail: upscaleThumbnail(pickThumb(song.thumbnails || song.thumbnail), id),
  }
}

function normalizeArtist(artist, fallbackQuery = '') {
  if (!artist) return null

  const id = String(artist.artistId || artist.browseId || '').trim() || normalizeText(fallbackQuery).replace(/\s+/g, '-')
  const name = String(artist.name || fallbackQuery || 'Unknown artist').trim()
  if (!id || !name) return null

  return {
    id,
    name,
    thumbnail: upscaleThumbnail(pickThumb(artist.thumbnails || artist.thumbnail)),
    query: fallbackQuery || name,
  }
}

function normalizeSyncedLyricLine(line) {
  const text = String(line?.text || '').trim()
  const startTime = Number(line?.startTime)

  if (!text || !Number.isFinite(startTime)) return null
  return { text, startTime }
}

function normalizeManualSyncedLyrics(lines = []) {
  if (!Array.isArray(lines)) return []

  return lines
    .map(normalizeSyncedLyricLine)
    .filter(Boolean)
    .sort((a, b) => a.startTime - b.startTime)
}

function normalizeManualLyricsText(lines = []) {
  if (!Array.isArray(lines)) return []

  return lines
    .map((line) => String(line || '').trim())
    .filter(Boolean)
}

function mergeManualLyricsIntoSyncedLyrics(lyrics = [], syncedLyrics = []) {
  const normalizedLyrics = normalizeManualLyricsText(lyrics)
  const normalizedSyncedLyrics = normalizeManualSyncedLyrics(syncedLyrics)

  if (!normalizedLyrics.length || !normalizedSyncedLyrics.length) return []
  if (normalizedLyrics.length !== normalizedSyncedLyrics.length) return []

  return normalizedSyncedLyrics.map((line, index) => ({
    ...line,
    text: normalizedLyrics[index],
  }))
}

function normalizeManualLyricsEntry(entry) {
  const videoId = String(entry?.videoId || '').trim()
  if (!videoId) return null

  const lyrics = normalizeManualLyricsText(entry?.lyrics)
  const lines = normalizeManualSyncedLyrics(entry?.lines)
  const derivedLyrics = lyrics.length ? lyrics : lines.map((line) => line.text)
  const thumbnail = typeof entry?.thumbnail === 'string' ? entry.thumbnail : ''
  if (!derivedLyrics.length && !lines.length && !thumbnail) return null

  return {
    videoId,
    title: String(entry?.title || '').trim(),
    artist: String(entry?.artist || '').trim(),
    album: String(entry?.album || '').trim(),
    lyrics: derivedLyrics,
    lines,
    thumbnail,
    updatedAt: String(entry?.updatedAt || new Date().toISOString()),
  }
}

async function getManualLyricsEntry(videoId) {
  const id = String(videoId || '').trim()
  if (!id) return null

  const store = await getManualLyricsStore()
  return normalizeManualLyricsEntry(store[id])
}

async function getSyncedLyricsSafe(query) {
  try {
    const body = await lrclib.findLyrics(query)

    if (!body || body.error) return []
    if (body.instrumental) {
      return [{ text: '[Instrumental]', startTime: 0 }]
    }
    if (!body.syncedLyrics) return []

    const parsed = parseLocalLyrics(body.syncedLyrics)?.synced
    return Array.isArray(parsed) ? parsed.map(normalizeSyncedLyricLine).filter(Boolean) : []
  } catch {
    return []
  }
}

async function fetchTimedLyrics({ title, artist, album, duration }) {
  const cleanTitle = String(title || '').trim()
  const cleanArtist = String(artist || '').trim()
  const cleanAlbum = String(album || '').trim()
  const cleanDuration = Number(duration) || 0
  const durationMs = cleanDuration > 0 ? Math.round(cleanDuration * 1000) : undefined

  if (!cleanTitle || !cleanArtist) return []

  const attempts = [
    {
      track_name: cleanTitle,
      artist_name: cleanArtist,
      album_name: cleanAlbum || undefined,
      duration: durationMs,
    },
    {
      track_name: cleanTitle,
      artist_name: cleanArtist,
      duration: durationMs,
    },
    {
      track_name: cleanTitle,
      artist_name: cleanArtist,
    },
  ]

  for (const attempt of attempts) {
    const synced = await getSyncedLyricsSafe(attempt)
    if (synced.length) return synced
  }

  try {
    const searchResults = await lrclib.searchLyrics({
      track_name: cleanTitle,
      artist_name: cleanArtist,
      duration: durationMs,
    })

    const ranked = (Array.isArray(searchResults) ? searchResults : [])
      .filter((item) => item?.syncedLyrics)
      .map((item, index) => {
        const titleScore = scoreMatch(cleanTitle, {
          title: item.trackName || item.name,
          artist: item.artistName,
          album: item.albumName,
        })
        const artistScore = normalizeLyricText(item.artistName).includes(normalizeLyricText(cleanArtist)) ? 40 : 0

        return {
          item,
          index,
          score: titleScore + artistScore,
        }
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)

    const best = ranked[0]?.item
    if (best?.id) {
      const synced = await getSyncedLyricsSafe({ id: best.id })
      if (synced.length) return synced
    }
  } catch {
    // Ignore lyric lookup noise.
  }

  return []
}

function dedupeById(list) {
  const seen = new Set()
  const output = []

  for (const item of list) {
    if (!item?.id || seen.has(item.id)) continue
    seen.add(item.id)
    output.push(item)
  }

  return output
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, source: 'ytmusic' })
})

app.get('/api/suggest', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    await ensureYtMusic()
    const suggestions = await ytmusic.getSearchSuggestions(query)
    res.json({ items: suggestions || [] })
  } catch (error) {
    res.status(500).json({ error: 'YT Music API suggest error' })
  }
})

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    await ensureYtMusic()

    const [songsResult, videosResult, mixedResult] = await Promise.allSettled([
      ytmusic.searchSongs(query),
      ytmusic.searchVideos(query),
      ytmusic.search(query),
    ])

    const songs = songsResult.status === 'fulfilled' ? songsResult.value : []
    const videos = videosResult.status === 'fulfilled' ? videosResult.value : []
    const mixed = mixedResult.status === 'fulfilled' ? mixedResult.value : []

    const merged = [...songs, ...videos, ...mixed]

    const ranked = dedupeById(merged.map(normalizeSong).filter(Boolean))
      .map((item, index) => ({ ...item, score: scoreMatch(query, item), rank: index }))
      .sort((a, b) => b.score - a.score || a.rank - b.rank)
      .slice(0, 30)
      .map(({ score, rank, ...item }) => item)

    res.json({ items: ranked })
  } catch {
    res.status(500).json({ error: 'YT Music API error' })
  }
})

app.get('/api/context', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim()
  const artistHint = String(req.query.artist || '').trim()
  const titleHint = String(req.query.title || '').trim()
  const albumHint = String(req.query.album || '').trim()
  const durationHint = Number(req.query.duration || 0) || 0

  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  try {
    await ensureYtMusic()

    const manualEntry = await getManualLyricsEntry(videoId)
    const [baseSong, remoteLyricsRaw] = await Promise.all([
      withTimeout(() => ytmusic.getSong(videoId), 6500, null),
      withTimeout(() => ytmusic.getLyrics(videoId), 6500, []),
    ])

    const artist = String(baseSong?.artist?.name || artistHint || '').trim()
    const title = String(baseSong?.name || titleHint || '').trim()
    const album = String(baseSong?.album?.name || albumHint || '').trim()
    const duration = parseDuration(baseSong?.duration || durationHint)
    const manualLyrics = manualEntry?.lyrics || []
    const manualSyncedLyrics = manualEntry?.lines || []
    const fetchedSyncedLyrics = manualSyncedLyrics.length
      ? []
      : await withTimeout(
          () =>
            fetchTimedLyrics({
              title,
              artist,
              album,
              duration,
            }),
          12000,
          []
        )
    const mergedManualSyncedLyrics =
      !manualSyncedLyrics.length && manualLyrics.length
        ? mergeManualLyricsIntoSyncedLyrics(manualLyrics, fetchedSyncedLyrics)
        : []
    const syncedLyrics = manualSyncedLyrics.length
      ? manualSyncedLyrics
      : mergedManualSyncedLyrics.length
        ? mergedManualSyncedLyrics
        : manualLyrics.length
          ? []
          : fetchedSyncedLyrics

    const remoteLyrics = Array.isArray(remoteLyricsRaw)
      ? remoteLyricsRaw.filter((line) => String(line || '').trim().length > 0)
      : []
    const lyrics = manualLyrics.length ? manualLyrics : remoteLyrics

    const lyricSource = manualLyrics.length || manualSyncedLyrics.length ? 'manual' : syncedLyrics.length ? 'synced' : lyrics.length ? 'static' : 'none'
    const canManualSync = true

    res.json({
      lyrics,
      syncedLyrics,
      lyricSource,
      canManualSync,
      hasManualSync: Boolean(manualLyrics.length || manualSyncedLyrics.length),
      thumbnail: manualEntry?.thumbnail || '',
    })
  } catch {
    res.status(500).json({ error: 'YT Music context error' })
  }
})

app.post('/api/manual-lyrics', async (req, res) => {
  const videoId = String(req.body?.videoId || '').trim()
  const title = String(req.body?.title || '').trim()
  const artist = String(req.body?.artist || '').trim()
  const album = String(req.body?.album || '').trim()
  const lyrics = normalizeManualLyricsText(req.body?.lyrics)
  const lines = normalizeManualSyncedLyrics(req.body?.lines)
  const thumbnail = String(req.body?.thumbnail || '').trim()

  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  if (!lyrics.length && !lines.length && !thumbnail) {
    return res.status(400).json({ error: 'Missing lyric content' })
  }

  try {
    const entry = normalizeManualLyricsEntry({
      videoId,
      title,
      artist,
      album,
      lyrics,
      lines,
      thumbnail,
      updatedAt: new Date().toISOString(),
    })

    if (!entry) {
      return res.status(400).json({ error: 'Invalid lyric data' })
    }

    const store = await getManualLyricsStore()
    store[videoId] = entry
    scheduleManualLyricsWrite()

    res.json({ item: entry })
  } catch {
    res.status(500).json({ error: 'Manual lyric save error' })
  }
})

app.delete('/api/manual-lyrics', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim()
  const mode = String(req.query.mode || 'all').trim()
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  try {
    const store = await getManualLyricsStore()
    const existing = normalizeManualLyricsEntry(store[videoId])

    if (!existing) {
      delete store[videoId]
    } else if (mode === 'thumbnail') {
      const nextEntry = normalizeManualLyricsEntry({
        ...existing,
        thumbnail: '',
        updatedAt: new Date().toISOString(),
      })

      if (nextEntry) {
        store[videoId] = nextEntry
      } else {
        delete store[videoId]
      }
    } else if (mode === 'lyrics') {
      const nextEntry = normalizeManualLyricsEntry({
        ...existing,
        lyrics: [],
        lines: [],
        updatedAt: new Date().toISOString(),
      })

      if (nextEntry) {
        store[videoId] = nextEntry
      } else {
        delete store[videoId]
      }
    } else {
      delete store[videoId]
    }

    scheduleManualLyricsWrite()

    res.json({ success: true })
  } catch {
    res.status(500).json({ error: 'Manual lyric delete error' })
  }
})

app.get('/api/artist', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    await ensureYtMusic()

    const results = await ytmusic.searchArtists(query)
    const ranked = (results || [])
      .map((artist, index) => ({
        normalized: normalizeArtist(artist, query),
        score: scoreArtistMatch(query, artist),
        rank: index,
      }))
      .filter((artist) => artist.normalized?.id && artist.normalized?.name)
      .sort((a, b) => b.score - a.score || a.rank - b.rank)[0]

    if (!ranked || ranked.score < 120) {
      return res.json({ item: null })
    }

    res.json({ item: ranked.normalized })
  } catch {
    res.status(500).json({ error: 'YT Music artist error' })
  }
})

app.get('/api/albums', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    await ensureYtMusic()

    const albums = await ytmusic.searchAlbums(query)
    const items = (albums || []).slice(0, 20).map((album) => ({
      albumId: album.albumId || '',
      playlistId: album.playlistId || '',
      name: String(album.name || 'Unknown album'),
      artist: String(album.artist?.name || 'Unknown artist'),
      artistId: String(album.artist?.artistId || ''),
      year: album.year || null,
      thumbnail: upscaleThumbnail(pickThumb(album.thumbnails || [])),
    })).filter(a => a.albumId)

    res.json({ items })
  } catch {
    res.status(500).json({ error: 'YT Music albums error' })
  }
})

app.get('/api/album/:id', async (req, res) => {
  const albumId = String(req.params.id || '').trim()
  if (!albumId) {
    return res.status(400).json({ error: 'Missing album id' })
  }

  try {
    await ensureYtMusic()

    const album = await ytmusic.getAlbum(albumId)
    if (!album) {
      return res.status(404).json({ error: 'Album not found' })
    }

    const songs = (album.songs || []).map(normalizeSong).filter(Boolean)

    res.json({
      name: String(album.name || 'Unknown album'),
      artist: String(album.artist?.name || 'Unknown artist'),
      year: album.year || null,
      thumbnail: upscaleThumbnail(pickThumb(album.thumbnails || [])),
      songs,
    })
  } catch {
    res.status(500).json({ error: 'YT Music album error' })
  }
})

app.get('/api/download', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim()
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`

  try {
    // Get title first
    const info = await youtubeDl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      ...cookieOpts(),
    })

    const rawTitle = typeof info === 'object' && info?.title ? String(info.title) : 'audio'
    const title = rawTitle.replace(/[^\w\s\u00C0-\u024F().,'!&-]/gi, '').trim() || 'audio'

    res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.mp3"`)
    res.header('Content-Type', 'audio/mpeg')

    // Stream audio directly to response
    const subprocess = youtubeDl.exec(url, {
      noPlaylist: true,
      format: 'bestaudio/best',
      extractAudio: true,
      audioFormat: 'mp3',
      ffmpegLocation: ffmpegPath,
      output: '-',
      quiet: true,
      ...cookieOpts(),
    })

    subprocess.stdout?.pipe(res)

    subprocess.stderr?.on('data', (chunk) => {
      console.error('[yt-dlp]', chunk.toString().trim())
    })

    subprocess.on('error', (err) => {
      console.error('[yt-dlp spawn error]', err.message)
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream audio' })
      }
    })

    req.on('close', () => {
      try { subprocess.kill() } catch {}
    })
  } catch (err) {
    console.error('[download error]', err?.message || err)
    if (!res.headersSent) {
      res.status(502).json({ error: 'Không thể tải audio. Thử lại sau.' })
    }
  }
})

app.post('/api/save-local', async (req, res) => {
  const videoId = String(req.body?.videoId || '').trim()
  const savePath = String(req.body?.savePath || '').trim()
  
  if (!videoId || !savePath) {
    return res.status(400).json({ error: 'Missing videoId or savePath' })
  }

  // Check if directory exists on THIS server
  try {
    const stat = await fs.stat(savePath)
    if (!stat.isDirectory()) {
      return res.status(400).json({ 
        error: `Đường dẫn "${savePath}" không phải thư mục trên server này.`,
        code: 'PATH_NOT_FOUND'
      })
    }
  } catch {
    return res.status(400).json({ 
      error: `Thư mục "${savePath}" không tồn tại trên server này. Tính năng lưu local chỉ hoạt động khi chạy server tại máy của bạn.`,
      code: 'PATH_NOT_FOUND'
    })
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`
  
  try {
    const info = await youtubeDl(url, {
      dumpSingleJson: true,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      ...cookieOpts(),
    })

    const rawTitle = typeof info === 'object' && info?.title ? String(info.title) : 'audio'
    // Clean title for file path
    const title = rawTitle.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'audio'
    const fullPath = path.join(savePath, `${title}.mp3`)

    console.log(`[save-local] Downloading ${videoId} to ${fullPath}`)

    await youtubeDl(url, {
      noPlaylist: true,
      format: 'bestaudio/best',
      extractAudio: true,
      audioFormat: 'mp3',
      ffmpegLocation: ffmpegPath,
      output: fullPath,
      quiet: true,
      ...cookieOpts(),
    })

    res.json({ success: true, path: fullPath })
  } catch (err) {
    console.error('[save-local error]', err?.message || err)
    res.status(500).json({ error: 'Lỗi tải xuống local.' })
  }
})

app.listen(port, '0.0.0.0', () => {
  console.log(`YT Music API listening on http://0.0.0.0:${port}`)
  initCookies()
})

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason)
})
