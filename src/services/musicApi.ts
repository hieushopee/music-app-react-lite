export interface Track {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  thumbnail: string
  sourceThumbnail?: string
}

export interface SyncedLyricLine {
  text: string
  startTime: number
}

export type LyricSource = 'manual' | 'synced' | 'static' | 'none'

export interface ArtistProfile {
  id: string
  name: string
  thumbnail: string
  query: string
}

export interface TrackContext {
  lyrics: string[]
  syncedLyrics: SyncedLyricLine[]
  lyricSource: LyricSource
  canManualSync: boolean
  hasManualSync: boolean
  thumbnail?: string
}

const TRACK_CONTEXT_CACHE_KEY = 'pulseframe-track-context-cache-v1'
const TRACK_CONTEXT_CACHE_LIMIT = 40
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const CONTEXT_REQUEST_TIMEOUT_MS = 20000

let trackContextCacheMemory: Record<string, { savedAt: number; context: TrackContext }> | null = null
let cachedWorkingBase: string | null = null

function normalizeBase(base: string | undefined | null) {
  return String(base || '').trim().replace(/\/+$/, '')
}

export function normalizeApiBase(base: string | undefined | null) {
  const raw = normalizeBase(base)
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

export function getConfiguredApiBase() {
  return normalizeApiBase(import.meta.env.VITE_API_BASE)
}

function buildCandidates(baseOverride = '') {
  const configured = getConfiguredApiBase()
  const candidates = [normalizeApiBase(baseOverride), configured]

  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location

    if (protocol === 'http:' || protocol === 'https:') {
      candidates.push(`${protocol}//${hostname}:5174`)
      if (port === '5174') {
        candidates.push(`${protocol}//${window.location.host}`)
      }
    }
  }

  candidates.push('', 'http://127.0.0.1:5174', 'http://localhost:5174')

  const unique: string[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const normalized = normalizeApiBase(candidate)
    const key = normalized || '/api'
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(normalized)
  }

  return unique
}

interface RequestJsonOptions {
  method?: string
  body?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

async function requestJson(base: string, path: string, options: RequestJsonOptions = {}) {
  const url = base ? `${base}${path}` : path
  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      body: options.body,
      headers: options.headers,
      signal: controller.signal,
    })
    const contentType = response.headers.get('content-type') || ''

    if (!contentType.includes('application/json')) {
      throw new Error('Phản hồi từ server không phải JSON.')
    }

    const data = await response.json()
    if (!response.ok) {
      const error = new Error(data?.error || 'Yêu cầu thất bại.') as Error & { kind?: string; status?: number }
      error.kind = 'api'
      error.status = response.status
      throw error
    }

    return data
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Hết thời gian kết nối tới server.')
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

async function requestViaCandidates(path: string, baseOverride = '', options: RequestJsonOptions = {}) {
  // If a working base was already found (and no override given), try it first
  if (!baseOverride && cachedWorkingBase !== null) {
    try {
      const result = await requestJson(cachedWorkingBase, path, options)
      return result
    } catch (error) {
      // If API-level error (e.g. 404), don't re-probe candidates
      if (error instanceof Error && 'kind' in error && (error as Error & { kind?: string }).kind === 'api') {
        throw error
      }
      // Otherwise cached base failed, clear and fall through to candidate probing
      cachedWorkingBase = null
    }
  }

  const candidates = buildCandidates(baseOverride)
  let lastError: Error | null = null

  for (const base of candidates) {
    try {
      const result = await requestJson(base, path, options)
      // Cache the base that worked
      if (!baseOverride) cachedWorkingBase = base
      return result
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Không thể kết nối server.')

      if (error instanceof Error && 'kind' in error && (error as Error & { kind?: string }).kind === 'api') {
        break
      }
    }
  }

  throw lastError || new Error('Không thể kết nối server.')
}

function normalizeTrack(track: unknown): Track | null {
  if (!track || typeof track !== 'object') return null

  const candidate = track as Partial<Track> & { videoId?: string }
  const id = String(candidate.id || candidate.videoId || '').trim()
  if (!id) return null

  return {
    id,
    title: String(candidate.title || 'Không rõ tiêu đề'),
    artist: String(candidate.artist || 'Không rõ nghệ sĩ'),
    album: String(candidate.album || 'YouTube Music'),
    duration: Number(candidate.duration || 0),
    thumbnail: typeof candidate.thumbnail === 'string' ? candidate.thumbnail : '',
    sourceThumbnail:
      typeof candidate.sourceThumbnail === 'string'
        ? candidate.sourceThumbnail
        : typeof candidate.thumbnail === 'string'
          ? candidate.thumbnail
          : '',
  }
}

function normalizeTrackList(list: unknown) {
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const output: Track[] = []

  for (const item of list) {
    const normalized = normalizeTrack(item)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    output.push(normalized)
  }

  return output
}

function normalizeSyncedLyrics(list: unknown) {
  if (!Array.isArray(list)) return []

  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const text = String((item as SyncedLyricLine).text || '').trim()
      const startTime = Number((item as SyncedLyricLine).startTime)

      if (!text || !Number.isFinite(startTime)) return null
      return { text, startTime }
    })
    .filter((item): item is SyncedLyricLine => Boolean(item))
    .sort((a, b) => a.startTime - b.startTime)
}

function normalizeLyricSource(value: unknown): LyricSource {
  return value === 'manual' || value === 'synced' || value === 'static' ? value : 'none'
}

function createEmptyTrackContext(): TrackContext {
  return {
    lyrics: [],
    syncedLyrics: [],
    lyricSource: 'none',
    canManualSync: false,
    hasManualSync: false,
  }
}

function normalizeTrackContext(data: unknown): TrackContext {
  const candidate = data as Partial<TrackContext> | null | undefined

  return {
    lyrics: Array.isArray(candidate?.lyrics) ? candidate.lyrics.map((line) => String(line || '').trim()).filter(Boolean) : [],
    syncedLyrics: normalizeSyncedLyrics(candidate?.syncedLyrics),
    lyricSource: normalizeLyricSource(candidate?.lyricSource),
    canManualSync: Boolean(candidate?.canManualSync),
    hasManualSync: Boolean(candidate?.hasManualSync),
    thumbnail: typeof candidate?.thumbnail === 'string' ? candidate.thumbnail : '',
  }
}

function mergeTrackContexts(nextContext: TrackContext, cachedContext: TrackContext | null) {
  if (!cachedContext) return nextContext
  if (nextContext.lyricSource === 'manual' || nextContext.syncedLyrics.length) return nextContext

  if (cachedContext.lyricSource === 'manual' || cachedContext.syncedLyrics.length) {
    return {
      ...nextContext,
      lyrics: nextContext.lyrics.length ? nextContext.lyrics : cachedContext.lyrics,
      syncedLyrics: cachedContext.syncedLyrics,
      lyricSource: cachedContext.lyricSource,
      canManualSync: nextContext.canManualSync || cachedContext.canManualSync,
      hasManualSync: nextContext.hasManualSync || cachedContext.hasManualSync,
    }
  }

  if (!nextContext.lyrics.length && cachedContext.lyrics.length) {
    return {
      ...nextContext,
      lyrics: cachedContext.lyrics,
      lyricSource: cachedContext.lyricSource,
      canManualSync: nextContext.canManualSync || cachedContext.canManualSync,
      hasManualSync: nextContext.hasManualSync || cachedContext.hasManualSync,
    }
  }

  return nextContext
}

function readTrackContextCacheStore() {
  if (trackContextCacheMemory && typeof trackContextCacheMemory === 'object') {
    return trackContextCacheMemory
  }

  if (typeof window === 'undefined') {
    trackContextCacheMemory = {}
    return trackContextCacheMemory
  }

  try {
    const raw = window.localStorage.getItem(TRACK_CONTEXT_CACHE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    trackContextCacheMemory = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    trackContextCacheMemory = {}
  }

  return trackContextCacheMemory
}

function writeTrackContextCacheStore(store: Record<string, { savedAt: number; context: TrackContext }>) {
  trackContextCacheMemory = store

  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(TRACK_CONTEXT_CACHE_KEY, JSON.stringify(store))
  } catch {
    // Ignore storage failures.
  }
}

function getCachedTrackContext(videoId: string) {
  const store = readTrackContextCacheStore()
  const entry = store?.[videoId]
  if (!entry?.context) return null

  return normalizeTrackContext(entry.context)
}

function saveTrackContext(videoId: string, context: unknown) {
  const normalized = normalizeTrackContext(context)
  const store = {
    ...readTrackContextCacheStore(),
    [videoId]: {
      savedAt: Date.now(),
      context: normalized,
    },
  }

  const trimmed = Object.fromEntries(
    Object.entries(store)
      .sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0))
      .slice(0, TRACK_CONTEXT_CACHE_LIMIT)
  )

  writeTrackContextCacheStore(trimmed)
  return normalized
}

export function invalidateTrackContextCache(videoId: string) {
  const store = readTrackContextCacheStore()
  if (store && store[videoId]) {
    delete store[videoId]
    writeTrackContextCacheStore(store)
  }
}

function normalizeArtistProfile(item: unknown, fallbackQuery: string): ArtistProfile | null {
  if (!item || typeof item !== 'object') return null

  const candidate = item as Partial<ArtistProfile> & { artistId?: string; browseId?: string }
  const id = String(candidate.id || candidate.artistId || candidate.browseId || fallbackQuery).trim()
  const name = String(candidate.name || fallbackQuery).trim()
  if (!id || !name) return null

  return {
    id,
    name,
    thumbnail: typeof candidate.thumbnail === 'string' ? candidate.thumbnail : '',
    query: String(candidate.query || fallbackQuery).trim() || name,
  }
}

export async function testApiBase(base: string) {
  const normalized = normalizeApiBase(base)
  const health = await requestJson(normalized, '/api/health')
  const probe = await requestJson(normalized, `/api/search?q=${encodeURIComponent('test music')}`)

  return {
    ...health,
    probe: 'search',
    sampleCount: Array.isArray(probe?.items) ? probe.items.length : 0,
  }
}

export async function searchMusic(query: string, baseOverride = '') {
  const keyword = String(query || '').trim()
  if (!keyword) return []

  const data = await requestViaCandidates(`/api/search?q=${encodeURIComponent(keyword)}`, baseOverride)
  return normalizeTrackList(data?.items)
}

export async function getSearchSuggestions(query: string, baseOverride = ''): Promise<string[]> {
  const keyword = String(query || '').trim()
  if (!keyword) return []

  try {
    const data = await requestViaCandidates(`/api/suggest?q=${encodeURIComponent(keyword)}`, baseOverride)
    return Array.isArray(data?.items) ? data.items : []
  } catch {
    return []
  }
}

export async function fetchTrackContext(track: Track | null, baseOverride = ''): Promise<TrackContext> {
  const videoId = String(track?.id || '').trim()
  if (!videoId) {
    return createEmptyTrackContext()
  }

  const params = new URLSearchParams({
    videoId,
    artist: String(track?.artist || ''),
    title: String(track?.title || ''),
    album: String(track?.album || ''),
    duration: String(track?.duration || 0),
  })

  const cachedContext = getCachedTrackContext(videoId)

  try {
    const data = await requestViaCandidates(`/api/context?${params.toString()}`, baseOverride, {
      timeoutMs: CONTEXT_REQUEST_TIMEOUT_MS,
    })

    return saveTrackContext(videoId, mergeTrackContexts(normalizeTrackContext(data), cachedContext))
  } catch {
    return cachedContext || createEmptyTrackContext()
  }
}

export async function fetchArtistProfile(query: string, baseOverride = '') {
  const keyword = String(query || '').trim()
  if (!keyword) return null

  const data = await requestViaCandidates(`/api/artist?q=${encodeURIComponent(keyword)}`, baseOverride)
  return normalizeArtistProfile(data?.item, keyword)
}

export async function saveManualLyrics(track: Track | null, lyrics: string[], lines: SyncedLyricLine[], baseOverride = '', thumbnail = '') {
  const videoId = String(track?.id || '').trim()
  if (!videoId) {
    throw new Error('Chưa có bài hát để lưu lyrics.')
  }

  const data = await requestViaCandidates('/api/manual-lyrics', baseOverride, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      videoId,
      title: String(track?.title || ''),
      artist: String(track?.artist || ''),
      album: String(track?.album || ''),
      lyrics,
      lines,
      thumbnail,
    }),
  })

  invalidateTrackContextCache(videoId)

  return {
    lyrics: Array.isArray(data?.item?.lyrics) ? data.item.lyrics.map((line: unknown) => String(line || '').trim()).filter(Boolean) : [],
    syncedLyrics: normalizeSyncedLyrics(data?.item?.lines),
  }
}

export async function deleteManualLyrics(videoId: string, baseOverride = '') {
  const id = String(videoId || '').trim()
  if (!id) {
    throw new Error('Thiếu videoId để xóa lời tự canh.')
  }

  const result = await requestViaCandidates(`/api/manual-lyrics?videoId=${encodeURIComponent(id)}`, baseOverride, {
    method: 'DELETE',
  })
  invalidateTrackContextCache(id)
  return result
}

export async function resetManualCover(videoId: string, baseOverride = '') {
  const id = String(videoId || '').trim()
  if (!id) {
    throw new Error('Thiếu videoId để reset ảnh bìa.')
  }

  const result = await requestViaCandidates(`/api/manual-lyrics?videoId=${encodeURIComponent(id)}&mode=thumbnail`, baseOverride, {
    method: 'DELETE',
  })
  invalidateTrackContextCache(id)
  return result
}

export async function resetManualLyrics(videoId: string, baseOverride = '') {
  const id = String(videoId || '').trim()
  if (!id) {
    throw new Error('Thiếu videoId để reset lyrics.')
  }

  const result = await requestViaCandidates(`/api/manual-lyrics?videoId=${encodeURIComponent(id)}&mode=lyrics`, baseOverride, {
    method: 'DELETE',
  })
  invalidateTrackContextCache(id)
  return result
}

export interface Album {
  albumId: string
  playlistId: string
  name: string
  artist: string
  artistId: string
  year: number | null
  thumbnail: string
}

export interface AlbumDetail {
  name: string
  artist: string
  year: number | null
  thumbnail: string
  songs: Track[]
}

export async function searchAlbums(query: string, baseOverride = ''): Promise<Album[]> {
  const keyword = String(query || '').trim()
  if (!keyword) return []

  const data = await requestViaCandidates(`/api/albums?q=${encodeURIComponent(keyword)}`, baseOverride)
  return Array.isArray(data?.items) ? data.items : []
}

export async function fetchAlbumDetail(albumId: string, baseOverride = ''): Promise<AlbumDetail | null> {
  const id = String(albumId || '').trim()
  if (!id) return null

  const data = await requestViaCandidates(`/api/album/${encodeURIComponent(id)}`, baseOverride)
  if (!data) return null

  return {
    name: String(data.name || ''),
    artist: String(data.artist || ''),
    year: data.year || null,
    thumbnail: String(data.thumbnail || ''),
    songs: normalizeTrackList(data.songs),
  }
}

