import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import YTMusic from 'ytmusic-api'
import lrclibApi from 'lrclib-api'
import pg from 'pg'
import crypto from 'node:crypto'
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
const databaseUrl = String(process.env.DATABASE_URL || '').trim()
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '6mb'
const maxCoverBytes = Number(process.env.MAX_COVER_BYTES || 2 * 1024 * 1024)
const lyricCacheTtlMs = Number(process.env.LYRIC_CACHE_TTL_DAYS || 60) * 24 * 60 * 60 * 1000
const lyricNegativeCacheTtlMs = Number(process.env.LYRIC_NEGATIVE_CACHE_TTL_DAYS || 2) * 24 * 60 * 60 * 1000
const { Pool } = pg
const dbPool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: shouldUseDatabaseSsl(databaseUrl) ? { rejectUnauthorized: false } : false,
    })
  : null

app.set('trust proxy', true)
app.use(cors())
app.use(express.json({ limit: jsonBodyLimit }))
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
let dbReadyPromise = null
let importedLegacyLyrics = false
const remoteLyricJobs = new Map()
const remoteLyricJobStatus = new Map()
const localLyricCache = new Map()

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

function shouldUseDatabaseSsl(url) {
  if (process.env.DATABASE_SSL === 'false') return false
  return !/localhost|127\.0\.0\.1/i.test(url)
}

async function ensureDatabase() {
  if (!dbPool) return false

  if (!dbReadyPromise) {
    dbReadyPromise = (async () => {
      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS manual_track_data (
          video_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          artist TEXT NOT NULL DEFAULT '',
          album TEXT NOT NULL DEFAULT '',
          lyrics JSONB NOT NULL DEFAULT '[]'::jsonb,
          lines JSONB NOT NULL DEFAULT '[]'::jsonb,
          cover_data BYTEA,
          cover_mime TEXT,
          cover_hash TEXT,
          cover_url TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)

      await dbPool.query(`
        CREATE TABLE IF NOT EXISTS lyric_cache (
          cache_key TEXT PRIMARY KEY,
          video_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          artist TEXT NOT NULL DEFAULT '',
          album TEXT NOT NULL DEFAULT '',
          duration_seconds INTEGER NOT NULL DEFAULT 0,
          lyrics JSONB NOT NULL DEFAULT '[]'::jsonb,
          lines JSONB NOT NULL DEFAULT '[]'::jsonb,
          source TEXT NOT NULL DEFAULT 'none',
          expires_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      await dbPool.query('CREATE INDEX IF NOT EXISTS lyric_cache_video_idx ON lyric_cache (video_id)')
      await dbPool.query('CREATE INDEX IF NOT EXISTS lyric_cache_expires_idx ON lyric_cache (expires_at)')

      await importLegacyManualLyricsIntoDatabase()
    })()
  }

  await dbReadyPromise
  return true
}

async function importLegacyManualLyricsIntoDatabase() {
  if (importedLegacyLyrics || !dbPool) return
  importedLegacyLyrics = true

  const legacyStore = await readManualLyricsStore()
  const entries = Object.values(legacyStore).map(normalizeManualLyricsEntry).filter(Boolean)
  if (!entries.length) return

  let imported = 0

  for (const entry of entries) {
    let cover = { buffer: null, mime: null, hash: null, url: '' }
    try {
      cover = parseCoverInput(entry.thumbnail)
    } catch (error) {
      console.warn(`Skipped oversized legacy cover for ${entry.videoId}:`, error.message)
    }

    const result = await dbPool.query(
      `
        INSERT INTO manual_track_data
          (video_id, title, artist, album, lyrics, lines, cover_data, cover_mime, cover_hash, cover_url, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)
        ON CONFLICT (video_id) DO NOTHING
      `,
      [
        entry.videoId,
        entry.title,
        entry.artist,
        entry.album,
        JSON.stringify(entry.lyrics),
        JSON.stringify(entry.lines),
        cover.buffer,
        cover.mime,
        cover.hash,
        cover.url,
        entry.updatedAt,
      ]
    )
    imported += result.rowCount || 0
  }

  if (imported) {
    console.log(`Imported ${imported} manual lyric entr${imported === 1 ? 'y' : 'ies'} into Postgres`)
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

function parseCoverInput(value) {
  const input = String(value || '').trim()
  if (!input) {
    return { buffer: null, mime: null, hash: null, url: '' }
  }

  const dataUrlMatch = input.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (dataUrlMatch) {
    const buffer = Buffer.from(dataUrlMatch[2], 'base64')
    if (!buffer.length) return { buffer: null, mime: null, hash: null, url: '' }
    if (buffer.length > maxCoverBytes) {
      const error = new Error(`Ảnh bìa quá lớn. Tối đa ${Math.round(maxCoverBytes / 1024 / 1024)}MB sau khi nén.`)
      error.status = 413
      throw error
    }

    return {
      buffer,
      mime: dataUrlMatch[1].toLowerCase(),
      hash: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24),
      url: '',
    }
  }

  if (/^https?:\/\//i.test(input)) {
    return {
      buffer: null,
      mime: null,
      hash: crypto.createHash('sha256').update(input).digest('hex').slice(0, 24),
      url: input,
    }
  }

  return { buffer: null, mime: null, hash: null, url: '' }
}

function getRequestOrigin(req) {
  const configured = String(process.env.PUBLIC_API_BASE || '').trim().replace(/\/+$/, '')
  if (configured) return configured

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim()
  const protocol = forwardedProto || req.protocol || 'http'
  return `${protocol}://${req.get('host')}`
}

function buildManualCoverUrl(req, videoId, version = '') {
  const suffix = version ? `?v=${encodeURIComponent(String(version))}` : ''
  return `${getRequestOrigin(req)}/api/manual-cover/${encodeURIComponent(videoId)}${suffix}`
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function createContextPayload({
  lyrics = [],
  syncedLyrics = [],
  lyricSource = 'none',
  canManualSync = true,
  hasManualSync = false,
  thumbnail = '',
  loadingRemoteLyrics = false,
} = {}) {
  return {
    lyrics: normalizeManualLyricsText(lyrics),
    syncedLyrics: normalizeManualSyncedLyrics(syncedLyrics),
    lyricSource,
    canManualSync,
    hasManualSync,
    thumbnail: String(thumbnail || ''),
    loadingRemoteLyrics,
  }
}

function getLyricCacheKey(videoId) {
  return String(videoId || '').trim()
}

function normalizeCachedLyricSource(value) {
  return value === 'synced' || value === 'static' || value === 'none' ? value : 'none'
}

function getLyricCacheExpiresAt(source) {
  const ttl = source === 'none' ? lyricNegativeCacheTtlMs : lyricCacheTtlMs
  return new Date(Date.now() + Math.max(ttl, 60 * 60 * 1000))
}

function mapLyricCacheRow(row) {
  if (!row) return null

  return createContextPayload({
    lyrics: parseJsonArray(row.lyrics),
    syncedLyrics: parseJsonArray(row.lines),
    lyricSource: normalizeCachedLyricSource(row.source),
  })
}

async function getCachedRemoteLyrics(videoId) {
  const cacheKey = getLyricCacheKey(videoId)
  if (!cacheKey) return null

  if (await ensureDatabase()) {
    const result = await dbPool.query(
      `
        SELECT lyrics, lines, source
        FROM lyric_cache
        WHERE cache_key = $1
          AND expires_at > NOW()
      `,
      [cacheKey]
    )
    return mapLyricCacheRow(result.rows[0])
  }

  const cached = localLyricCache.get(cacheKey)
  if (!cached || cached.expiresAt <= Date.now()) {
    localLyricCache.delete(cacheKey)
    return null
  }

  return createContextPayload(cached.context)
}

async function saveRemoteLyricsCache(videoId, meta, context) {
  const cacheKey = getLyricCacheKey(videoId)
  if (!cacheKey) return

  const payload = createContextPayload(context)
  const source = normalizeCachedLyricSource(payload.lyricSource)
  const expiresAt = getLyricCacheExpiresAt(source)

  if (await ensureDatabase()) {
    await dbPool.query(
      `
        INSERT INTO lyric_cache
          (cache_key, video_id, title, artist, album, duration_seconds, lyrics, lines, source, expires_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, NOW())
        ON CONFLICT (cache_key) DO UPDATE SET
          video_id = EXCLUDED.video_id,
          title = EXCLUDED.title,
          artist = EXCLUDED.artist,
          album = EXCLUDED.album,
          duration_seconds = EXCLUDED.duration_seconds,
          lyrics = EXCLUDED.lyrics,
          lines = EXCLUDED.lines,
          source = EXCLUDED.source,
          expires_at = EXCLUDED.expires_at,
          updated_at = NOW()
      `,
      [
        cacheKey,
        cacheKey,
        String(meta?.title || ''),
        String(meta?.artist || ''),
        String(meta?.album || ''),
        Math.round(Number(meta?.duration || 0) || 0),
        JSON.stringify(payload.lyrics),
        JSON.stringify(payload.syncedLyrics),
        source,
        expiresAt,
      ]
    )
    return
  }

  localLyricCache.set(cacheKey, {
    expiresAt: expiresAt.getTime(),
    context: payload,
  })
}

function mapManualLyricsRow(row, req = null) {
  if (!row) return null

  const hasStoredCover = Boolean(row.has_cover || row.cover_data)
  const thumbnail = hasStoredCover
    ? req
      ? buildManualCoverUrl(req, row.video_id, row.cover_hash || row.updated_at)
      : '__manual_cover__'
    : String(row.cover_url || '')

  return normalizeManualLyricsEntry({
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    lyrics: parseJsonArray(row.lyrics),
    lines: parseJsonArray(row.lines),
    thumbnail,
    updatedAt: row.updated_at,
  })
}

async function getManualLyricsEntry(videoId, req = null) {
  const id = String(videoId || '').trim()
  if (!id) return null

  if (await ensureDatabase()) {
    const result = await dbPool.query(
      `
        SELECT
          video_id, title, artist, album, lyrics, lines, cover_url, cover_mime, cover_hash, updated_at,
          cover_data IS NOT NULL AS has_cover
        FROM manual_track_data
        WHERE video_id = $1
      `,
      [id]
    )
    return mapManualLyricsRow(result.rows[0], req)
  }

  const store = await getManualLyricsStore()
  return normalizeManualLyricsEntry(store[id])
}

async function saveManualLyricsEntry(input, thumbnail) {
  const entry = normalizeManualLyricsEntry(input)
  if (!entry) return null

  const cover = parseCoverInput(thumbnail)
  const hasCoverUpdate = Boolean(cover.buffer || cover.url)

  if (await ensureDatabase()) {
    const result = await dbPool.query(
      `
        INSERT INTO manual_track_data
          (video_id, title, artist, album, lyrics, lines, cover_data, cover_mime, cover_hash, cover_url, updated_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, NOW())
        ON CONFLICT (video_id) DO UPDATE SET
          title = EXCLUDED.title,
          artist = EXCLUDED.artist,
          album = EXCLUDED.album,
          lyrics = EXCLUDED.lyrics,
          lines = EXCLUDED.lines,
          cover_data = CASE WHEN $11 THEN EXCLUDED.cover_data ELSE manual_track_data.cover_data END,
          cover_mime = CASE WHEN $11 THEN EXCLUDED.cover_mime ELSE manual_track_data.cover_mime END,
          cover_hash = CASE WHEN $11 THEN EXCLUDED.cover_hash ELSE manual_track_data.cover_hash END,
          cover_url = CASE WHEN $11 THEN EXCLUDED.cover_url ELSE manual_track_data.cover_url END,
          updated_at = NOW()
        RETURNING
          video_id, title, artist, album, lyrics, lines, cover_url, cover_mime, cover_hash, updated_at,
          cover_data IS NOT NULL AS has_cover
      `,
      [
        entry.videoId,
        entry.title,
        entry.artist,
        entry.album,
        JSON.stringify(entry.lyrics),
        JSON.stringify(entry.lines),
        cover.buffer,
        cover.mime,
        cover.hash,
        cover.url,
        hasCoverUpdate,
      ]
    )
    return mapManualLyricsRow(result.rows[0])
  }

  const store = await getManualLyricsStore()
  const previous = normalizeManualLyricsEntry(store[entry.videoId])
  store[entry.videoId] = {
    ...entry,
    thumbnail: hasCoverUpdate ? thumbnail : previous?.thumbnail || entry.thumbnail || '',
    updatedAt: new Date().toISOString(),
  }
  await writeManualLyricsStore(store)
  return normalizeManualLyricsEntry(store[entry.videoId])
}

async function deleteManualLyricsEntry(videoId, mode) {
  const id = String(videoId || '').trim()
  if (!id) return

  if (await ensureDatabase()) {
    if (mode === 'thumbnail') {
      await dbPool.query(
        `
          DELETE FROM manual_track_data
          WHERE video_id = $1
            AND jsonb_array_length(lyrics) = 0
            AND jsonb_array_length(lines) = 0
        `,
        [id]
      )
      await dbPool.query(
        `
          UPDATE manual_track_data
          SET cover_data = NULL, cover_mime = NULL, cover_hash = NULL, cover_url = '', updated_at = NOW()
          WHERE video_id = $1
        `,
        [id]
      )
      return
    }

    if (mode === 'lyrics') {
      await dbPool.query(
        `
          UPDATE manual_track_data
          SET lyrics = '[]'::jsonb, lines = '[]'::jsonb, updated_at = NOW()
          WHERE video_id = $1
        `,
        [id]
      )
      await dbPool.query(
        `
          DELETE FROM manual_track_data
          WHERE video_id = $1
            AND cover_data IS NULL
            AND cover_url = ''
        `,
        [id]
      )
      return
    }

    await dbPool.query('DELETE FROM manual_track_data WHERE video_id = $1', [id])
    return
  }

  const store = await getManualLyricsStore()
  const existing = normalizeManualLyricsEntry(store[id])

  if (!existing) {
    delete store[id]
  } else if (mode === 'thumbnail') {
    const nextEntry = normalizeManualLyricsEntry({
      ...existing,
      thumbnail: '',
      updatedAt: new Date().toISOString(),
    })

    if (nextEntry) {
      store[id] = nextEntry
    } else {
      delete store[id]
    }
  } else if (mode === 'lyrics') {
    const nextEntry = normalizeManualLyricsEntry({
      ...existing,
      lyrics: [],
      lines: [],
      updatedAt: new Date().toISOString(),
    })

    if (nextEntry) {
      store[id] = nextEntry
    } else {
      delete store[id]
    }
  } else {
    delete store[id]
  }

  await writeManualLyricsStore(store)
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

async function fetchRemoteTrackContext({ videoId, artistHint, titleHint, albumHint, durationHint }) {
  await ensureYtMusic()

  const [baseSong, remoteLyricsRaw] = await Promise.all([
    withTimeout(() => ytmusic.getSong(videoId), 4500, null),
    withTimeout(() => ytmusic.getLyrics(videoId), 4500, []),
  ])

  const artist = String(baseSong?.artist?.name || artistHint || '').trim()
  const title = String(baseSong?.name || titleHint || '').trim()
  const album = String(baseSong?.album?.name || albumHint || '').trim()
  const duration = parseDuration(baseSong?.duration || durationHint)
  const syncedLyrics = await withTimeout(
    () =>
      fetchTimedLyrics({
        title,
        artist,
        album,
        duration,
      }),
    9000,
    []
  )
  const lyrics = Array.isArray(remoteLyricsRaw)
    ? remoteLyricsRaw.filter((line) => String(line || '').trim().length > 0)
    : []
  const lyricSource = syncedLyrics.length ? 'synced' : lyrics.length ? 'static' : 'none'

  return {
    meta: { title, artist, album, duration },
    context: createContextPayload({
      lyrics,
      syncedLyrics,
      lyricSource,
    }),
  }
}

function queueRemoteLyricRefresh(params) {
  const cacheKey = getLyricCacheKey(params.videoId)
  if (!cacheKey || remoteLyricJobs.has(cacheKey)) return

  remoteLyricJobStatus.set(cacheKey, {
    state: 'running',
    startedAt: new Date().toISOString(),
  })

  const job = fetchRemoteTrackContext(params)
    .then(async ({ meta, context }) => {
      await saveRemoteLyricsCache(cacheKey, meta, context)
      remoteLyricJobStatus.set(cacheKey, {
        state: 'done',
        source: context.lyricSource,
        lyrics: context.lyrics.length,
        syncedLyrics: context.syncedLyrics.length,
        finishedAt: new Date().toISOString(),
      })
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Remote lyric refresh failed:', message)
      remoteLyricJobStatus.set(cacheKey, {
        state: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      })

      return saveRemoteLyricsCache(cacheKey, {
        title: params.titleHint,
        artist: params.artistHint,
        album: params.albumHint,
        duration: params.durationHint,
      }, createContextPayload({ lyricSource: 'none' })).catch((saveError) => {
        console.error('Failed to save negative lyric cache:', saveError instanceof Error ? saveError.message : saveError)
      })
    })
    .finally(() => {
      remoteLyricJobs.delete(cacheKey)
    })

  remoteLyricJobs.set(cacheKey, job)
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
  try {
    await ensureDatabase()
    res.json({ ok: true, source: 'ytmusic', storage: dbPool ? 'postgres' : 'json' })
  } catch {
    res.status(500).json({ ok: false, source: 'ytmusic', storage: 'postgres', error: 'Database connection error' })
  }
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
    const manualEntry = await getManualLyricsEntry(videoId, req)
    const manualLyrics = manualEntry?.lyrics || []
    const manualSyncedLyrics = manualEntry?.lines || []
    const thumbnail = manualEntry?.thumbnail || ''

    if (manualLyrics.length || manualSyncedLyrics.length) {
      return res.json(
        createContextPayload({
          lyrics: manualLyrics,
          syncedLyrics: manualSyncedLyrics,
          lyricSource: 'manual',
          hasManualSync: true,
          thumbnail,
        })
      )
    }

    const cachedContext = await getCachedRemoteLyrics(videoId)
    if (cachedContext) {
      return res.json({
        ...cachedContext,
        thumbnail,
      })
    }

    queueRemoteLyricRefresh({
      videoId,
      artistHint,
      titleHint,
      albumHint,
      durationHint,
    })

    return res.json(
      createContextPayload({
        thumbnail,
        loadingRemoteLyrics: true,
      })
    )
  } catch {
    res.status(500).json({ error: 'YT Music context error' })
  }
})

app.get('/api/context-status', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim()
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  try {
    const manualEntry = await getManualLyricsEntry(videoId, req)
    let cache = null

    if (await ensureDatabase()) {
      const result = await dbPool.query(
        `
          SELECT source, jsonb_array_length(lyrics) AS lyric_count,
                 jsonb_array_length(lines) AS synced_count,
                 expires_at, updated_at
          FROM lyric_cache
          WHERE cache_key = $1
        `,
        [videoId]
      )
      const row = result.rows[0]
      cache = row
        ? {
            source: row.source,
            lyrics: Number(row.lyric_count || 0),
            syncedLyrics: Number(row.synced_count || 0),
            expiresAt: row.expires_at,
            updatedAt: row.updated_at,
          }
        : null
    } else {
      const cached = localLyricCache.get(videoId)
      cache = cached
        ? {
            source: cached.context?.lyricSource || 'none',
            lyrics: cached.context?.lyrics?.length || 0,
            syncedLyrics: cached.context?.syncedLyrics?.length || 0,
            expiresAt: new Date(cached.expiresAt).toISOString(),
          }
        : null
    }

    res.json({
      ok: true,
      storage: dbPool ? 'postgres' : 'json',
      videoId,
      manual: {
        hasLyrics: Boolean(manualEntry?.lyrics?.length || manualEntry?.lines?.length),
        lyrics: manualEntry?.lyrics?.length || 0,
        syncedLyrics: manualEntry?.lines?.length || 0,
        hasThumbnail: Boolean(manualEntry?.thumbnail),
      },
      cache,
      job: remoteLyricJobStatus.get(videoId) || null,
    })
  } catch {
    res.status(500).json({ error: 'Context status error' })
  }
})

app.get('/api/manual-cover/:videoId', async (req, res) => {
  const videoId = String(req.params.videoId || '').trim()
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  try {
    if (await ensureDatabase()) {
      const result = await dbPool.query(
        'SELECT cover_data, cover_mime, cover_hash, updated_at FROM manual_track_data WHERE video_id = $1',
        [videoId]
      )
      const row = result.rows[0]

      if (!row?.cover_data) {
        return res.status(404).json({ error: 'Manual cover not found' })
      }

      const etag = row.cover_hash ? `"${row.cover_hash}"` : null
      if (etag && req.get('if-none-match') === etag) {
        return res.status(304).end()
      }

      if (etag) res.set('ETag', etag)
      res.set('Content-Type', row.cover_mime || 'image/jpeg')
      res.set('Cache-Control', 'public, max-age=31536000, immutable')
      return res.send(row.cover_data)
    }

    const entry = await getManualLyricsEntry(videoId, req)
    const thumbnail = String(entry?.thumbnail || '')
    if (/^https?:\/\//i.test(thumbnail)) {
      return res.redirect(thumbnail)
    }

    const cover = parseCoverInput(thumbnail)
    if (!cover.buffer) {
      return res.status(404).json({ error: 'Manual cover not found' })
    }

    if (cover.hash) res.set('ETag', `"${cover.hash}"`)
    res.set('Content-Type', cover.mime || 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    return res.send(cover.buffer)
  } catch (error) {
    res.status(error?.status || 500).json({ error: 'Manual cover read error' })
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
    const entry = await saveManualLyricsEntry({
      videoId,
      title,
      artist,
      album,
      lyrics,
      lines,
      thumbnail,
      updatedAt: new Date().toISOString(),
    }, thumbnail)

    if (!entry) {
      return res.status(400).json({ error: 'Invalid lyric data' })
    }

    res.json({ item: entry })
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || 'Manual lyric save error' })
  }
})

app.delete('/api/manual-lyrics', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim()
  const mode = String(req.query.mode || 'all').trim()
  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' })
  }

  try {
    await deleteManualLyricsEntry(videoId, mode)
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

app.listen(port, '0.0.0.0', () => {
  console.log(`YT Music API listening on http://0.0.0.0:${port}`)
})

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason)
})
