import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import lrclibApi from 'lrclib-api'
import pg from 'pg'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const app = express()
const port = process.env.PORT || 5174
const serverDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(serverDir, 'data')
const manualLyricsPath = path.join(dataDir, 'manual-lyrics.json')
const frontendDist = path.join(serverDir, '..', 'dist')

app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use(express.static(frontendDist))

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) {
    return next()
  }
  res.sendFile(path.join(frontendDist, 'index.html'))
})

const { Client: LRCLibClient, parseLocalLyrics } = lrclibApi
const lrclib = new LRCLibClient()
const youtubeApiKey = String(process.env.YOUTUBE_API_KEY || '').trim()
const youtubeApiBase = 'https://www.googleapis.com/youtube/v3'
const youtubeCache = new Map()
const databaseUrl = String(process.env.DATABASE_URL || '').trim()
const database = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    })
  : null
let inMemoryStore = null
let writeTimeout = null
let databaseReadyPromise = null
let databaseLastError = ''

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

async function ensureManualLyricsStore() {
  await fs.mkdir(dataDir, { recursive: true })

  try {
    await fs.access(manualLyricsPath)
  } catch {
    await fs.writeFile(manualLyricsPath, '{}', 'utf8')
  }
}

async function ensureDatabase() {
  if (!database) return false
  if (!databaseReadyPromise) {
    databaseReadyPromise = database.query(`
      CREATE TABLE IF NOT EXISTS manual_lyrics (
        video_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
  }

  try {
    await databaseReadyPromise
    databaseLastError = ''
    return true
  } catch (error) {
    databaseReadyPromise = null
    databaseLastError = error instanceof Error ? error.message : 'Unknown database error'
    throw error
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

async function saveManualLyricsEntry(entry) {
  if (await ensureDatabase()) {
    await database.query(
      `INSERT INTO manual_lyrics (video_id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (video_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [entry.videoId, JSON.stringify(entry)]
    )
    return
  }

  const store = await getManualLyricsStore()
  store[entry.videoId] = entry
  scheduleManualLyricsWrite()
}

async function removeManualLyricsEntry(videoId) {
  if (await ensureDatabase()) {
    await database.query('DELETE FROM manual_lyrics WHERE video_id = $1', [videoId])
    return
  }

  const store = await getManualLyricsStore()
  delete store[videoId]
  scheduleManualLyricsWrite()
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

function parseYouTubeDuration(value) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i)
  if (!match) return 0
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)
}

function pickYouTubeThumbnail(thumbnails = {}) {
  return String(thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '')
}

async function requestYouTube(pathname, params, cacheMs = 10 * 60 * 1000) {
  if (!youtubeApiKey) {
    throw new Error('YOUTUBE_API_KEY is not configured')
  }

  const search = new URLSearchParams({ key: youtubeApiKey })
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim()) {
      search.set(key, String(value))
    }
  }

  const cacheKey = `${pathname}?${search.toString()}`
  const cached = youtubeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch(`${youtubeApiBase}${pathname}?${search.toString()}`, { signal: controller.signal })
    const body = await response.json()
    if (!response.ok) {
      throw new Error(body?.error?.message || `YouTube Data API returned ${response.status}`)
    }

    if (youtubeCache.size >= 200) {
      youtubeCache.delete(youtubeCache.keys().next().value)
    }
    youtubeCache.set(cacheKey, { value: body, expiresAt: Date.now() + cacheMs })
    return body
  } finally {
    clearTimeout(timer)
  }
}

async function searchYouTubeVideos(query, maxResults = 20) {
  const search = await requestYouTube('/search', {
    part: 'snippet',
    q: query,
    type: 'video',
    videoEmbeddable: 'true',
    maxResults,
    relevanceLanguage: 'vi',
  })
  const ids = (search.items || []).map((item) => item?.id?.videoId).filter(Boolean)
  if (!ids.length) return []

  const videos = await requestYouTube('/videos', {
    part: 'snippet,contentDetails',
    id: ids.join(','),
  })
  const byId = new Map((videos.items || []).map((item) => [item.id, item]))

  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((video) => ({
      id: video.id,
      title: String(video.snippet?.title || 'Unknown title'),
      artist: String(video.snippet?.channelTitle || 'Unknown artist'),
      album: 'YouTube',
      duration: parseYouTubeDuration(video.contentDetails?.duration),
      thumbnail: pickYouTubeThumbnail(video.snippet?.thumbnails),
    }))
}

async function getYouTubeVideo(videoId) {
  const result = await requestYouTube('/videos', {
    part: 'snippet,contentDetails',
    id: videoId,
  })
  return result.items?.[0] || null
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

function buildManualDraftLines(lyrics = [], syncedLyrics = []) {
  const normalizedLyrics = normalizeManualLyricsText(lyrics)
  const normalizedSyncedLyrics = normalizeManualSyncedLyrics(syncedLyrics)
  const used = new Set()

  return normalizedLyrics.map((text) => {
    const matchIndex = normalizedSyncedLyrics.findIndex((line, index) => !used.has(index) && line.text === text)
    if (matchIndex >= 0) {
      used.add(matchIndex)
      return {
        text,
        startTime: normalizedSyncedLyrics[matchIndex].startTime,
      }
    }

    return {
      text,
      startTime: null,
    }
  })
}

function isCompleteManualSync(lyrics = [], syncedLyrics = []) {
  const draftLines = buildManualDraftLines(lyrics, syncedLyrics)
  return Boolean(draftLines.length && draftLines.every((line) => Number.isFinite(line.startTime)))
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

  if (await ensureDatabase()) {
    const result = await database.query('SELECT data FROM manual_lyrics WHERE video_id = $1', [id])
    return normalizeManualLyricsEntry(result.rows[0]?.data)
  }

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

app.get('/api/health', async (_req, res) => {
  let databaseStatus = database ? 'connected' : 'not-configured'

  if (database) {
    try {
      await ensureDatabase()
    } catch {
      databaseStatus = 'unavailable'
    }
  }

  res.json({
    ok: true,
    source: 'youtube-data-api',
    configured: Boolean(youtubeApiKey),
    database: databaseStatus,
    databaseError: databaseStatus === 'unavailable' ? databaseLastError : undefined,
  })
})

app.get('/api/suggest', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  // Search suggestions are intentionally local-only to preserve YouTube API
  // quota; selecting a result still performs a full official API search.
  res.json({ items: [] })
})

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    res.json({ items: await searchYouTubeVideos(query) })
  } catch (error) {
    console.error('YouTube search error:', error instanceof Error ? error.message : error)
    res.status(503).json({ error: 'YouTube search is temporarily unavailable.' })
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
    const manualEntry = await getManualLyricsEntry(videoId)
    const baseSong = await withTimeout(() => getYouTubeVideo(videoId), 6500, null)

    const artist = String(baseSong?.snippet?.channelTitle || artistHint || '').trim()
    const title = String(baseSong?.snippet?.title || titleHint || '').trim()
    const album = String(albumHint || '').trim()
    const duration = parseYouTubeDuration(baseSong?.contentDetails?.duration) || durationHint
    const manualLyrics = manualEntry?.lyrics || []
    const manualStoredLines = manualEntry?.lines || []
    const manualDraftLines = buildManualDraftLines(manualLyrics, manualStoredLines)
    const manualSyncComplete = isCompleteManualSync(manualLyrics, manualStoredLines)
    const manualSyncedLyrics = manualSyncComplete
      ? manualDraftLines.map((line) => ({ text: line.text, startTime: line.startTime || 0 }))
      : []
    const fetchedSyncedLyrics = manualStoredLines.length
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

    const lyrics = manualLyrics

    const lyricSource = manualLyrics.length || manualSyncedLyrics.length ? 'manual' : syncedLyrics.length ? 'synced' : lyrics.length ? 'static' : 'none'
    const canManualSync = true

    res.json({
      lyrics,
      syncedLyrics,
      manualLines: manualDraftLines,
      lyricSource,
      canManualSync,
      hasManualSync: Boolean(manualLyrics.length || manualStoredLines.length),
      thumbnail: manualEntry?.thumbnail || '',
    })
  } catch (error) {
    console.error('YouTube context error:', error instanceof Error ? error.message : error)
    res.status(500).json({ error: 'Track context error' })
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

    await saveManualLyricsEntry(entry)

    res.json({ item: entry })
  } catch (error) {
    console.error('Manual lyric save error:', error instanceof Error ? error.message : error)
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
    const existing = await getManualLyricsEntry(videoId)

    if (!existing) {
      await removeManualLyricsEntry(videoId)
    } else if (mode === 'thumbnail') {
      const nextEntry = normalizeManualLyricsEntry({
        ...existing,
        thumbnail: '',
        updatedAt: new Date().toISOString(),
      })

      if (nextEntry) {
        await saveManualLyricsEntry(nextEntry)
      } else {
        await removeManualLyricsEntry(videoId)
      }
    } else if (mode === 'lyrics') {
      const nextEntry = normalizeManualLyricsEntry({
        ...existing,
        lyrics: [],
        lines: [],
        updatedAt: new Date().toISOString(),
      })

      if (nextEntry) {
        await saveManualLyricsEntry(nextEntry)
      } else {
        await removeManualLyricsEntry(videoId)
      }
    } else {
      await removeManualLyricsEntry(videoId)
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Manual lyric delete error:', error instanceof Error ? error.message : error)
    res.status(500).json({ error: 'Manual lyric delete error' })
  }
})

app.get('/api/artist', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    const results = await requestYouTube('/search', {
      part: 'snippet',
      q: query,
      type: 'channel',
      maxResults: 5,
      relevanceLanguage: 'vi',
    }, 12 * 60 * 60 * 1000)
    const ranked = (results.items || [])
      .map((artist, index) => ({
        normalized: {
          id: String(artist.id?.channelId || '').trim(),
          // Keep the rail label clean while using the matching channel's avatar.
          name: query,
          thumbnail: pickYouTubeThumbnail(artist.snippet?.thumbnails),
          query,
        },
        score: scoreArtistMatch(query, { name: artist.snippet?.title }),
        rank: index,
      }))
      .filter((artist) => artist.normalized?.id && artist.normalized?.name)
      .sort((a, b) => b.score - a.score || a.rank - b.rank)[0]

    if (!ranked || ranked.score < 120) {
      return res.json({ item: null })
    }

    res.json({ item: ranked.normalized })
  } catch (error) {
    // Artist lookup only feeds optional avatar shortcuts. Do not turn a
    // temporary upstream block into a client-side error storm.
    console.error('YouTube artist error:', error instanceof Error ? error.message : error)
    res.json({ item: null })
  }
})

app.get('/api/albums', async (req, res) => {
  const query = String(req.query.q || '').trim()
  if (!query) {
    return res.status(400).json({ error: 'Missing q parameter' })
  }

  try {
    const results = await requestYouTube('/search', {
      part: 'snippet',
      q: query,
      type: 'playlist',
      maxResults: 12,
      relevanceLanguage: 'vi',
    }, 60 * 60 * 1000)
    const items = (results.items || []).map((playlist) => ({
      albumId: String(playlist.id?.playlistId || ''),
      playlistId: String(playlist.id?.playlistId || ''),
      name: String(playlist.snippet?.title || 'YouTube playlist'),
      artist: String(playlist.snippet?.channelTitle || 'YouTube'),
      artistId: String(playlist.snippet?.channelId || ''),
      year: playlist.snippet?.publishedAt ? Number(String(playlist.snippet.publishedAt).slice(0, 4)) : null,
      thumbnail: pickYouTubeThumbnail(playlist.snippet?.thumbnails),
    })).filter((item) => item.albumId)

    res.json({ items })
  } catch (error) {
    console.error('YouTube playlist error:', error instanceof Error ? error.message : error)
    res.status(503).json({ error: 'YouTube playlists are temporarily unavailable.' })
  }
})

app.get('/api/album/:id', async (req, res) => {
  const albumId = String(req.params.id || '').trim()
  if (!albumId) {
    return res.status(400).json({ error: 'Missing album id' })
  }

  try {
    const [playlistResult, playlistItemsResult] = await Promise.all([
      requestYouTube('/playlists', { part: 'snippet', id: albumId }, 60 * 60 * 1000),
      requestYouTube('/playlistItems', { part: 'snippet,contentDetails', playlistId: albumId, maxResults: 50 }, 60 * 60 * 1000),
    ])
    const playlist = playlistResult.items?.[0]
    if (!playlist) {
      return res.status(404).json({ error: 'Album not found' })
    }

    const videoIds = (playlistItemsResult.items || [])
      .map((item) => item.contentDetails?.videoId || item.snippet?.resourceId?.videoId)
      .filter(Boolean)
    const videos = videoIds.length
      ? await requestYouTube('/videos', { part: 'snippet,contentDetails', id: videoIds.join(',') }, 60 * 60 * 1000)
      : { items: [] }
    const byId = new Map((videos.items || []).map((video) => [video.id, video]))
    const songs = videoIds
      .map((videoId) => byId.get(videoId))
      .filter(Boolean)
      .map((video) => ({
        id: video.id,
        title: String(video.snippet?.title || 'Unknown title'),
        artist: String(video.snippet?.channelTitle || 'Unknown artist'),
        album: String(playlist.snippet?.title || 'YouTube playlist'),
        duration: parseYouTubeDuration(video.contentDetails?.duration),
        thumbnail: pickYouTubeThumbnail(video.snippet?.thumbnails),
      }))

    res.json({
      name: String(playlist.snippet?.title || 'YouTube playlist'),
      artist: String(playlist.snippet?.channelTitle || 'YouTube'),
      year: playlist.snippet?.publishedAt ? Number(String(playlist.snippet.publishedAt).slice(0, 4)) : null,
      thumbnail: pickYouTubeThumbnail(playlist.snippet?.thumbnails),
      songs,
    })
  } catch (error) {
    console.error('YouTube playlist detail error:', error instanceof Error ? error.message : error)
    res.status(503).json({ error: 'YouTube playlist is temporarily unavailable.' })
  }
})

app.listen(port, '0.0.0.0', () => {
  console.log(`Music API listening on http://0.0.0.0:${port}`)
})

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason)
})
