export interface Env {
  ASSETS: Fetcher
  DB: D1Database
  YOUTUBE_API_KEY: string
}

interface Track {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  thumbnail: string
}

interface SyncedLyricLine {
  text: string
  startTime: number
}

interface ManualLyricsEntry {
  videoId: string
  title: string
  artist: string
  album: string
  lyrics: string[]
  lines: SyncedLyricLine[]
  thumbnail: string
  updatedAt: string
}

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'
const LRCLIB_API_BASE = 'https://lrclib.net/api'
const YOUTUBE_MUSIC_BASE = 'https://music.youtube.com'
const YOUTUBE_MUSIC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

interface YouTubeMusicConfig {
  apiKey: string
  apiVersion: string
  clientName: string
  contextClientName: string
  clientVersion: string
  visitorData: string
}

let cachedYouTubeMusicConfig: { expiresAt: number; config: YouTubeMusicConfig } | null = null

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, url)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

async function handleApiRequest(request: Request, env: Env, url: URL) {
  try {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      await env.DB.prepare('SELECT 1 FROM manual_lyrics LIMIT 1').first()
      return json({ ok: true, source: 'cloudflare-worker', database: 'connected', configured: Boolean(env.YOUTUBE_API_KEY) })
    }

    if (request.method === 'GET' && url.pathname === '/api/suggest') {
      const query = url.searchParams.get('q')?.trim() || ''
      if (!query) return json({ error: 'Missing q parameter' }, 400)
      return json({ items: await getYouTubeSuggestions(query) })
    }

    if (request.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim() || ''
      if (!query) return json({ error: 'Missing q parameter' }, 400)
      if (!env.YOUTUBE_API_KEY) {
        return json({ error: 'Thiếu YOUTUBE_API_KEY. Hãy cấu hình secret cho Worker để tìm bài hát.' }, 503)
      }
      return json({ items: await searchYouTubeVideos(env, query) })
    }

    if (request.method === 'GET' && url.pathname === '/api/context') {
      return getTrackContext(env, url)
    }

    if (request.method === 'POST' && url.pathname === '/api/manual-lyrics') {
      return saveManualLyrics(env, request)
    }

    if (request.method === 'DELETE' && url.pathname === '/api/manual-lyrics') {
      return deleteManualLyrics(env, url)
    }

    if (request.method === 'GET' && url.pathname === '/api/artist') {
      return getArtist(env, url)
    }

    if (request.method === 'GET' && url.pathname === '/api/albums') {
      if (!env.YOUTUBE_API_KEY) {
        return json({ error: 'Thiếu YOUTUBE_API_KEY. Hãy cấu hình secret cho Worker để tìm playlist.' }, 503)
      }
      return getPlaylists(env, url)
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/album/')) {
      if (!env.YOUTUBE_API_KEY) {
        return json({ error: 'Thiếu YOUTUBE_API_KEY. Hãy cấu hình secret cho Worker để tải playlist.' }, 503)
      }
      return getPlaylistDetail(env, decodeURIComponent(url.pathname.slice('/api/album/'.length)))
    }

    return json({ error: 'Not found' }, 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Server error'
    console.error('API error:', message)
    if (/quota|dailyLimitExceeded/i.test(message)) {
      return json({ error: 'Đã chạm giới hạn tìm kiếm YouTube trong ngày. Vui lòng thử lại sau khi quota được đặt lại.' }, 429)
    }
    return json({ error: message }, 500)
  }
}

async function getYouTubeSuggestions(query: string): Promise<string[]> {
  const url = new URL('https://suggestqueries.google.com/complete/search')
  url.searchParams.set('client', 'firefox')
  url.searchParams.set('ds', 'yt')
  url.searchParams.set('q', query.slice(0, 100))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`YouTube suggestions returned ${response.status}`)
    }

    const payload: unknown = await response.json()
    if (!Array.isArray(payload) || !Array.isArray(payload[1])) return []

    return [...new Set(
      payload[1]
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )].slice(0, 8)
  } catch (error) {
    console.warn('YouTube suggestions unavailable:', error instanceof Error ? error.message : error)
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

async function getManualLyricsEntry(env: Env, videoId: string) {
  const row = await env.DB.prepare('SELECT data FROM manual_lyrics WHERE video_id = ?').bind(videoId).first<{ data: string }>()
  if (!row?.data) return null

  try {
    return normalizeManualLyricsEntry(JSON.parse(row.data))
  } catch {
    return null
  }
}

async function writeManualLyricsEntry(env: Env, entry: ManualLyricsEntry) {
  await env.DB.prepare(
    `INSERT INTO manual_lyrics (video_id, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(entry.videoId, JSON.stringify(entry), entry.updatedAt).run()
}

async function removeManualLyricsEntry(env: Env, videoId: string) {
  await env.DB.prepare('DELETE FROM manual_lyrics WHERE video_id = ?').bind(videoId).run()
}

function normalizeManualLyricsText(lines: unknown) {
  if (!Array.isArray(lines)) return []
  return lines.map((line) => String(line || '').trim()).filter(Boolean)
}

function normalizeManualSyncedLyrics(lines: unknown): SyncedLyricLine[] {
  if (!Array.isArray(lines)) return []
  return lines
    .map((line) => {
      const candidate = line as Partial<SyncedLyricLine>
      const text = String(candidate?.text || '').trim()
      const startTime = Number(candidate?.startTime)
      return text && Number.isFinite(startTime) ? { text, startTime } : null
    })
    .filter((line): line is SyncedLyricLine => Boolean(line))
    .sort((a, b) => a.startTime - b.startTime)
}

function normalizeManualLyricsEntry(entry: unknown): ManualLyricsEntry | null {
  const candidate = entry as Partial<ManualLyricsEntry> | null | undefined
  const videoId = String(candidate?.videoId || '').trim()
  if (!videoId) return null

  const lyrics = normalizeManualLyricsText(candidate?.lyrics)
  const lines = normalizeManualSyncedLyrics(candidate?.lines)
  const thumbnail = typeof candidate?.thumbnail === 'string' ? candidate.thumbnail : ''
  if (!lyrics.length && !lines.length && !thumbnail) return null

  return {
    videoId,
    title: String(candidate?.title || '').trim(),
    artist: String(candidate?.artist || '').trim(),
    album: String(candidate?.album || '').trim(),
    lyrics: lyrics.length ? lyrics : lines.map((line) => line.text),
    lines,
    thumbnail,
    updatedAt: String(candidate?.updatedAt || new Date().toISOString()),
  }
}

function buildManualDraftLines(lyrics: string[], syncedLyrics: SyncedLyricLine[]) {
  const used = new Set<number>()
  return lyrics.map((text) => {
    const index = syncedLyrics.findIndex((line, lineIndex) => !used.has(lineIndex) && line.text === text)
    if (index >= 0) {
      used.add(index)
      return { text, startTime: syncedLyrics[index].startTime }
    }
    return { text, startTime: null }
  })
}

function isCompleteManualSync(lyrics: string[], lines: SyncedLyricLine[]) {
  const draft = buildManualDraftLines(lyrics, lines)
  return Boolean(draft.length && draft.every((line) => Number.isFinite(line.startTime)))
}

function mergeManualLyricsIntoSyncedLyrics(lyrics: string[], lines: SyncedLyricLine[]) {
  if (!lyrics.length || lyrics.length !== lines.length) return []
  return lines.map((line, index) => ({ ...line, text: lyrics[index] }))
}

async function saveManualLyrics(env: Env, request: Request) {
  const body = await request.json<Partial<ManualLyricsEntry>>()
  const entry = normalizeManualLyricsEntry({
    videoId: body.videoId,
    title: body.title,
    artist: body.artist,
    album: body.album,
    lyrics: body.lyrics,
    lines: body.lines,
    thumbnail: body.thumbnail,
    updatedAt: new Date().toISOString(),
  })

  if (!entry) return json({ error: 'Missing lyric content or videoId' }, 400)
  await writeManualLyricsEntry(env, entry)
  return json({ item: entry })
}

async function deleteManualLyrics(env: Env, url: URL) {
  const videoId = url.searchParams.get('videoId')?.trim() || ''
  const mode = url.searchParams.get('mode') || 'all'
  if (!videoId) return json({ error: 'Missing videoId parameter' }, 400)

  const existing = await getManualLyricsEntry(env, videoId)
  if (!existing || mode === 'all') {
    await removeManualLyricsEntry(env, videoId)
    return json({ success: true })
  }

  const next = normalizeManualLyricsEntry({
    ...existing,
    thumbnail: mode === 'thumbnail' ? '' : existing.thumbnail,
    lyrics: mode === 'lyrics' ? [] : existing.lyrics,
    lines: mode === 'lyrics' ? [] : existing.lines,
    updatedAt: new Date().toISOString(),
  })

  if (next) await writeManualLyricsEntry(env, next)
  else await removeManualLyricsEntry(env, videoId)
  return json({ success: true })
}

async function getTrackContext(env: Env, url: URL) {
  const videoId = url.searchParams.get('videoId')?.trim() || ''
  if (!videoId) return json({ error: 'Missing videoId parameter' }, 400)

  const artistHint = url.searchParams.get('artist')?.trim() || ''
  const titleHint = url.searchParams.get('title')?.trim() || ''
  const albumHint = url.searchParams.get('album')?.trim() || ''
  const durationHint = Number(url.searchParams.get('duration') || 0) || 0
  const [manualEntry, video] = await Promise.all([
    getManualLyricsEntry(env, videoId),
    getYouTubeVideo(env, videoId).catch(() => null),
  ])

  const artist = String(video?.snippet?.channelTitle || artistHint).trim()
  const title = String(video?.snippet?.title || titleHint).trim()
  const duration = parseYouTubeDuration(video?.contentDetails?.duration) || durationHint
  const manualLyrics = manualEntry?.lyrics || []
  const manualLines = manualEntry?.lines || []
  const manualDraftLines = buildManualDraftLines(manualLyrics, manualLines)
  const manualSynced = isCompleteManualSync(manualLyrics, manualLines)
    ? manualDraftLines.map((line) => ({ text: line.text, startTime: line.startTime || 0 }))
    : []
  const [youtubeMusicLyrics, remoteLyrics] = await Promise.all([
    manualLyrics.length
      ? Promise.resolve([])
      : fetchYouTubeMusicLyrics(videoId).catch((error) => {
          console.warn('YouTube Music lyric lookup failed:', error instanceof Error ? error.message : error)
          return []
        }),
    manualLines.length
          ? { lyrics: [], syncedLyrics: [] }
          : await fetchTimedLyrics({
              title,
              artist,
              artistHint,
              album: albumHint,
              duration,
            })
  ])
  const merged = !manualSynced.length && manualLyrics.length
    ? mergeManualLyricsIntoSyncedLyrics(manualLyrics, remoteLyrics.syncedLyrics)
    : []
  const syncedLyrics = manualSynced.length
    ? manualSynced
    : merged.length
      ? merged
      : manualLyrics.length
        ? []
        : remoteLyrics.syncedLyrics
  const lyrics = manualLyrics.length
    ? manualLyrics
    : youtubeMusicLyrics.length
      ? youtubeMusicLyrics
      : remoteLyrics.lyrics.length
        ? remoteLyrics.lyrics
      : syncedLyrics.map((line) => line.text)

  return json({
    lyrics,
    syncedLyrics,
    manualLines: manualDraftLines,
    lyricSource: manualLyrics.length || manualSynced.length
      ? 'manual'
      : syncedLyrics.length
        ? 'synced'
        : lyrics.length
          ? 'static'
          : 'none',
    canManualSync: true,
    hasManualSync: Boolean(manualLyrics.length || manualLines.length),
    thumbnail: manualEntry?.thumbnail || '',
  })
}

async function getArtist(env: Env, url: URL) {
  const query = url.searchParams.get('q')?.trim() || ''
  if (!query) return json({ error: 'Missing q parameter' }, 400)

  const item = await fetchYouTubeMusicArtistProfile(query)
  return json({ item })
}

async function getPlaylists(env: Env, url: URL) {
  const query = url.searchParams.get('q')?.trim() || ''
  if (!query) return json({ error: 'Missing q parameter' }, 400)

  const results = await requestYouTube(env, '/search', {
    part: 'snippet', q: query, type: 'playlist', maxResults: 12, relevanceLanguage: 'vi',
  }, 24 * 60 * 60)
  const items = (results.items || []).map((item: any) => ({
    albumId: String(item.id?.playlistId || ''),
    playlistId: String(item.id?.playlistId || ''),
    name: String(item.snippet?.title || 'YouTube playlist'),
    artist: String(item.snippet?.channelTitle || 'YouTube'),
    artistId: String(item.snippet?.channelId || ''),
    year: item.snippet?.publishedAt ? Number(String(item.snippet.publishedAt).slice(0, 4)) : null,
    thumbnail: pickYouTubeThumbnail(item.snippet?.thumbnails),
  })).filter((item: any) => item.albumId)
  return json({ items })
}

async function getPlaylistDetail(env: Env, playlistId: string) {
  if (!playlistId) return json({ error: 'Missing album id' }, 400)
  const [playlists, playlistItems] = await Promise.all([
    requestYouTube(env, '/playlists', { part: 'snippet', id: playlistId }, 60 * 60),
    requestYouTube(env, '/playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: 50 }, 60 * 60),
  ])
  const playlist = playlists.items?.[0]
  if (!playlist) return json({ error: 'Album not found' }, 404)

  const ids = (playlistItems.items || []).map((item: any) => item.contentDetails?.videoId || item.snippet?.resourceId?.videoId).filter(Boolean)
  const videoData = ids.length ? await requestYouTube(env, '/videos', { part: 'snippet,contentDetails', id: ids.join(',') }, 60 * 60) : { items: [] }
  const byId = new Map((videoData.items || []).map((item: any) => [item.id, item]))
  const songs = ids.map((id: string) => byId.get(id)).filter(Boolean).map(normalizeYouTubeVideo)

  return json({
    name: String(playlist.snippet?.title || 'YouTube playlist'),
    artist: String(playlist.snippet?.channelTitle || 'YouTube'),
    year: playlist.snippet?.publishedAt ? Number(String(playlist.snippet.publishedAt).slice(0, 4)) : null,
    thumbnail: pickYouTubeThumbnail(playlist.snippet?.thumbnails),
    songs,
  })
}

async function searchYouTubeVideos(env: Env, query: string) {
  const results = await requestYouTube(env, '/search', {
    part: 'snippet', q: query, type: 'video', videoEmbeddable: 'true', maxResults: 20, relevanceLanguage: 'vi',
  }, 24 * 60 * 60)
  const ids = (results.items || []).map((item: any) => item.id?.videoId).filter(Boolean)
  if (!ids.length) return []
  const videos = await requestYouTube(env, '/videos', { part: 'snippet,contentDetails', id: ids.join(',') }, 24 * 60 * 60)
  const byId = new Map((videos.items || []).map((item: any) => [item.id, item]))
  return ids.map((id: string) => byId.get(id)).filter(Boolean).map(normalizeYouTubeVideo)
}

async function getYouTubeVideo(env: Env, videoId: string) {
  const results = await requestYouTube(env, '/videos', { part: 'snippet,contentDetails', id: videoId }, 10 * 60)
  return results.items?.[0] || null
}

async function requestYouTube(env: Env, path: string, params: Record<string, string | number | undefined>, cacheSeconds: number) {
  if (!env.YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not configured')
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && String(value).trim()) search.set(key, String(value))
  }

  // Cloudflare Workers exposes its edge cache as caches.default.
  const cache = (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(`https://music-api-cache.invalid${path}?${search.toString()}`)
  const cached = await cache.match(cacheKey)
  if (cached) return cached.json()

  search.set('key', env.YOUTUBE_API_KEY)
  const response = await fetch(`${YOUTUBE_API_BASE}${path}?${search.toString()}`)
  const body = await response.json<any>()
  if (!response.ok) throw new Error(body?.error?.message || `YouTube Data API returned ${response.status}`)

  await cache.put(cacheKey, new Response(JSON.stringify(body), {
    headers: { 'Cache-Control': `public, max-age=${cacheSeconds}`, 'Content-Type': 'application/json' },
  }))
  return body
}

function normalizeYouTubeVideo(video: any): Track {
  return {
    id: String(video.id),
    title: String(video.snippet?.title || 'Unknown title'),
    artist: String(video.snippet?.channelTitle || 'Unknown artist'),
    album: 'YouTube',
    duration: parseYouTubeDuration(video.contentDetails?.duration),
    thumbnail: pickYouTubeThumbnail(video.snippet?.thumbnails),
  }
}

function parseYouTubeDuration(value: unknown) {
  const match = String(value || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i)
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : 0
}

function pickYouTubeThumbnail(thumbnails: any) {
  return String(thumbnails?.maxres?.url || thumbnails?.standard?.url || thumbnails?.high?.url || thumbnails?.medium?.url || thumbnails?.default?.url || '')
}

function normalizeText(value: unknown) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

function scoreArtistMatch(query: string, artistName: unknown) {
  const q = normalizeText(query)
  const name = normalizeText(artistName)
  if (!q || !name) return 0
  if (name === q) return 500
  if (name.startsWith(q) || q.startsWith(name)) return 340
  if (name.includes(q) || q.includes(name)) return 260
  return 0
}

function parseLrc(input: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = []
  for (const rawLine of String(input || '').split(/\r?\n/)) {
    const text = rawLine.replace(/\[[0-9]{1,2}:[0-9]{2}(?:[.:][0-9]{1,3})?\]/g, '').trim()
    const timestamps = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g)]
    for (const match of timestamps) {
      if (!text) continue
      lines.push({ text, startTime: Number(match[1]) * 60 + Number(match[2].replace(':', '.')) })
    }
  }
  return lines.filter((line) => Number.isFinite(line.startTime)).sort((a, b) => a.startTime - b.startTime)
}

async function fetchYouTubeMusicLyrics(videoId: string): Promise<string[]> {
  const cache = (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(`https://music-api-cache.invalid/youtube-music-lyrics/${encodeURIComponent(videoId)}`)
  const cached = await cache.match(cacheKey)
  if (cached) {
    const lyrics: unknown = await cached.json()
    return Array.isArray(lyrics) ? lyrics.filter((line): line is string => typeof line === 'string') : []
  }

  const config = await getYouTubeMusicConfig()
  const next = await requestYouTubeMusicApi(config, 'next', { videoId })
  const lyricsBrowseId = findYouTubeMusicLyricsBrowseId(next)
  if (!lyricsBrowseId) return []

  const browse = await requestYouTubeMusicApi(config, 'browse', { browseId: lyricsBrowseId })
  const lyricsText = findYouTubeMusicLyricsText(browse)
  const lyrics = lyricsText
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lyrics.length) {
    await cache.put(cacheKey, new Response(JSON.stringify(lyrics), {
      headers: { 'Cache-Control': 'public, max-age=43200', 'Content-Type': 'application/json' },
    }))
  }
  return lyrics
}

async function fetchYouTubeMusicArtistProfile(query: string) {
  const cache = (caches as unknown as { default: Cache }).default
  const cacheKey = new Request(
    `https://music-api-cache.invalid/youtube-music-artist/${encodeURIComponent(normalizeText(query))}`
  )
  const cached = await cache.match(cacheKey)
  if (cached) return await cached.json<{ id: string; name: string; query: string; thumbnail: string } | null>()

  const config = await getYouTubeMusicConfig()
  const data = await requestYouTubeMusicApi(config, 'search', {
    query,
    params: 'Eg-KAQwIABAAGAAgASgAMABqChAEEAMQCRAFEAo=',
  })
  const candidates = collectYouTubeMusicArtistProfiles(data, query)
  const profile = candidates.sort((a, b) => b.score - a.score)[0]
  const result = profile && profile.score >= 100
    ? { id: profile.id, name: query, query, thumbnail: profile.thumbnail }
    : null

  await cache.put(cacheKey, new Response(JSON.stringify(result), {
    headers: { 'Cache-Control': 'public, max-age=43200', 'Content-Type': 'application/json' },
  }))
  return result
}

async function getYouTubeMusicConfig(): Promise<YouTubeMusicConfig> {
  if (cachedYouTubeMusicConfig && cachedYouTubeMusicConfig.expiresAt > Date.now()) {
    return cachedYouTubeMusicConfig.config
  }

  const response = await fetch(`${YOUTUBE_MUSIC_BASE}/`, {
    headers: {
      'Accept-Language': 'vi,en-US;q=0.9,en;q=0.8',
      'User-Agent': YOUTUBE_MUSIC_USER_AGENT,
    },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`YouTube Music config returned ${response.status}`)

  const html = await response.text()
  const configs = [...html.matchAll(/ytcfg\.set\((\{.*?\})\);/gs)]
    .map((match) => {
      try {
        return JSON.parse(match[1]) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((config): config is Record<string, unknown> => Boolean(config))
  const raw = configs.find((config) => config.INNERTUBE_API_KEY && config.INNERTUBE_CLIENT_VERSION)
  if (!raw) throw new Error('YouTube Music client configuration was not found')

  const config: YouTubeMusicConfig = {
    apiKey: String(raw.INNERTUBE_API_KEY),
    apiVersion: String(raw.INNERTUBE_API_VERSION || 'v1'),
    clientName: String(raw.INNERTUBE_CLIENT_NAME || 'WEB_REMIX'),
    contextClientName: String(raw.INNERTUBE_CONTEXT_CLIENT_NAME || '67'),
    clientVersion: String(raw.INNERTUBE_CLIENT_VERSION),
    visitorData: String(raw.VISITOR_DATA || ''),
  }
  cachedYouTubeMusicConfig = { config, expiresAt: Date.now() + 6 * 60 * 60 * 1000 }
  return config
}

async function requestYouTubeMusicApi(
  config: YouTubeMusicConfig,
  endpoint: string,
  body: Record<string, string>
) {
  const url = new URL(`/youtubei/${config.apiVersion}/${endpoint}`, YOUTUBE_MUSIC_BASE)
  url.searchParams.set('key', config.apiKey)
  url.searchParams.set('alt', 'json')

  const context = {
    client: {
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      hl: 'vi',
      gl: 'VN',
      visitorData: config.visitorData,
    },
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: YOUTUBE_MUSIC_BASE,
      'User-Agent': YOUTUBE_MUSIC_USER_AGENT,
      'X-YouTube-Client-Name': config.contextClientName,
      'X-YouTube-Client-Version': config.clientVersion,
      ...(config.visitorData ? { 'X-Goog-Visitor-Id': config.visitorData } : {}),
    },
    body: JSON.stringify({ context, ...body }),
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`YouTube Music ${endpoint} returned ${response.status}`)
  return await response.json<unknown>()
}

function collectYouTubeMusicArtistProfiles(data: unknown, query: string) {
  const candidates: Array<{ id: string; thumbnail: string; score: number }> = []
  const stack: unknown[] = [data]
  const seenIds = new Set<string>()

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    const renderer = record.musicResponsiveListItemRenderer as Record<string, unknown> | undefined
    if (renderer) {
      const profile = parseYouTubeMusicArtistResult(renderer, query)
      if (profile && !seenIds.has(profile.id)) {
        seenIds.add(profile.id)
        candidates.push(profile)
      }
    }
    stack.push(...Object.values(record))
  }

  return candidates
}

function parseYouTubeMusicArtistResult(renderer: Record<string, unknown>, query: string) {
  const browseIds: string[] = []
  const thumbnailUrls: string[] = []
  const stack: unknown[] = [renderer]

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    const browseEndpoint = record.browseEndpoint as Record<string, unknown> | undefined
    const browseConfig = browseEndpoint?.browseEndpointContextSupportedConfigs as Record<string, unknown> | undefined
    const musicConfig = browseConfig?.browseEndpointContextMusicConfig as Record<string, unknown> | undefined
    if (musicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST' && typeof browseEndpoint?.browseId === 'string') {
      browseIds.push(browseEndpoint.browseId)
    }

    const thumbnail = record.thumbnail as Record<string, unknown> | undefined
    const thumbnailRenderer = thumbnail?.musicThumbnailRenderer as Record<string, unknown> | undefined
    const thumbnailData = thumbnailRenderer?.thumbnail as Record<string, unknown> | undefined
    const thumbnails = thumbnailData?.thumbnails
    if (Array.isArray(thumbnails)) {
      for (const item of thumbnails) {
        if (item && typeof item === 'object') {
          const url = (item as Record<string, unknown>).url
          if (typeof url === 'string') thumbnailUrls.push(url)
        }
      }
    }
    stack.push(...Object.values(record))
  }

  const id = browseIds[0]
  const thumbnail = thumbnailUrls[thumbnailUrls.length - 1] || ''
  if (!id || !thumbnail) return null

  const flexColumns = renderer.flexColumns
  const name = Array.isArray(flexColumns)
    ? extractMusicText(flexColumns[0])
    : ''
  const score = scoreArtistMatch(query, name)
  if (!name || score < 120) return null

  return { id, thumbnail: upgradeYouTubeMusicThumbnail(thumbnail), score }
}

function extractMusicText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(extractMusicText).filter(Boolean).join(' ')

  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  return Object.values(record).map(extractMusicText).filter(Boolean).join(' ').trim()
}

function upgradeYouTubeMusicThumbnail(url: string) {
  return url.replace(/=w\d+-h\d+[^?]*/i, '=w512-h512-l90-rj')
}

function findYouTubeMusicLyricsBrowseId(data: unknown) {
  const stack: unknown[] = [data]
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    const tab = record.tabRenderer as Record<string, unknown> | undefined
    const endpoint = tab?.endpoint as Record<string, unknown> | undefined
    const browseEndpoint = endpoint?.browseEndpoint as Record<string, unknown> | undefined
    const browseId = String(browseEndpoint?.browseId || tab?.browseId || '')
    if (browseId.startsWith('MPLYt')) return browseId

    stack.push(...Object.values(record))
  }

  return ''
}

function findYouTubeMusicLyricsText(data: unknown) {
  const stack: unknown[] = [data]
  let bestText = ''

  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue

    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    const description = record.description
    if (description && typeof description === 'object' && !Array.isArray(description)) {
      const runs = (description as Record<string, unknown>).runs
      if (Array.isArray(runs)) {
        const text = runs
          .map((run) => run && typeof run === 'object' ? String((run as Record<string, unknown>).text || '') : '')
          .join('')
        if (text.length > bestText.length) bestText = text
      }
    }

    stack.push(...Object.values(record))
  }

  return bestText
}

async function fetchTimedLyrics({
  title,
  artist,
  artistHint,
  album,
  duration,
}: {
  title: string
  artist: string
  artistHint: string
  album: string
  duration: number
}) {
  const cleanTitle = cleanLyricsTitle(title)
  const cleanArtist = cleanLyricsArtist(artist)
  if (!cleanTitle || !cleanArtist) return { lyrics: [], syncedLyrics: [] }

  let plainFallback: string[] = []
  const exactParams = buildLyricsParams(cleanTitle, cleanArtist, album, duration)

  try {
    const exact = await requestLrclibJson(
      `${LRCLIB_API_BASE}/get?${exactParams.toString()}`
    )
    if (exact) {
      const syncedLyrics = parseLrc(exact.syncedLyrics)
      const lyrics = parsePlainLyrics(exact.plainLyrics)
      if (syncedLyrics.length) return { lyrics, syncedLyrics }
      plainFallback = lyrics
    }
  } catch (error) {
    console.warn('LRCLIB exact lyric lookup failed:', error instanceof Error ? error.message : error)
  }

  const artistCandidates = [...new Set([cleanArtist, cleanLyricsArtist(artistHint)].filter(Boolean))]
  const titleCandidates = [...new Set([cleanTitle, title.trim()].filter(Boolean))]
  const seenQueries = new Set<string>()
  let bestSynced: { score: number; lyrics: string[]; syncedLyrics: SyncedLyricLine[] } | null = null
  let bestPlain: { score: number; lyrics: string[] } | null = null

  for (const candidateTitle of titleCandidates) {
    for (const candidateArtist of artistCandidates) {
      const queryKey = `${normalizeText(candidateTitle)}|${normalizeText(candidateArtist)}`
      if (seenQueries.has(queryKey)) continue
      seenQueries.add(queryKey)

      const params = buildLyricsParams(candidateTitle, candidateArtist, album, duration)
      try {
        const items = await requestLrclibJson(`${LRCLIB_API_BASE}/search?${params.toString()}`)
        if (!Array.isArray(items)) continue

        for (const item of items) {
          const syncedLyrics = parseLrc(item?.syncedLyrics)
          const lyrics = parsePlainLyrics(item?.plainLyrics)
          if (!syncedLyrics.length && !lyrics.length) continue

          const score = scoreLyricsMatch(item, candidateTitle, candidateArtist, duration)
          if (syncedLyrics.length && (!bestSynced || score > bestSynced.score)) {
            bestSynced = { score, lyrics, syncedLyrics }
          } else if (lyrics.length && (!bestPlain || score > bestPlain.score)) {
            bestPlain = { score, lyrics }
          }
        }
      } catch (error) {
        console.warn('LRCLIB lyric search failed:', error instanceof Error ? error.message : error)
      }

      if (bestSynced && bestSynced.score >= 180) {
        return bestSynced
      }
    }
  }

  if (bestSynced) return bestSynced
  return { lyrics: bestPlain?.lyrics || plainFallback, syncedLyrics: [] }
}

function buildLyricsParams(title: string, artist: string, album: string, duration: number) {
  const params = new URLSearchParams({
    track_name: title,
    artist_name: artist,
  })
  if (album) params.set('album_name', album)
  if (duration) params.set('duration', String(Math.round(duration)))
  return params
}

async function requestLrclibJson(url: string): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PulseFrameMusicApp/1.0',
      },
      signal: controller.signal,
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`)
    return await response.json<any>()
  } finally {
    clearTimeout(timeout)
  }
}

function cleanLyricsTitle(value: string) {
  return String(value || '')
    .replace(/\s*[\[(（][^\])）]*(?:official|music video|lyric(?:s)?|audio|4k|mv)[^\])）]*[\])）]/gi, ' ')
    .replace(/\s*[-|]\s*(?:official|music video|lyric(?:s)?|audio|4k|mv)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanLyricsArtist(value: string) {
  return String(value || '')
    .replace(/\s+-\s+topic$/i, '')
    .replace(/\s+(?:vevo|official)$/i, '')
    .trim()
}

function scoreLyricsMatch(item: any, title: string, artist: string, duration: number) {
  const titleScore = scoreTextMatch(title, String(item?.trackName || item?.name || ''))
  const artistScore = scoreTextMatch(artist, String(item?.artistName || ''))
  const candidateDuration = Number(item?.duration || 0)
  const durationDifference = duration && candidateDuration ? Math.abs(duration - candidateDuration) : 0
  const durationScore = !durationDifference
    ? 0
    : durationDifference <= 3
      ? 40
      : durationDifference <= 8
        ? 25
        : durationDifference <= 20
          ? 10
          : -Math.min(durationDifference, 60)

  return titleScore + artistScore + durationScore
}

function scoreTextMatch(expected: string, actual: string) {
  const expectedNormalized = normalizeText(expected)
  const actualNormalized = normalizeText(actual)
  if (!expectedNormalized || !actualNormalized) return 0
  if (expectedNormalized === actualNormalized) return 100
  if (expectedNormalized.includes(actualNormalized) || actualNormalized.includes(expectedNormalized)) return 75

  const expectedWords = new Set(expectedNormalized.split(' '))
  const actualWords = new Set(actualNormalized.split(' '))
  const intersection = [...expectedWords].filter((word) => actualWords.has(word)).length
  return Math.round((intersection / Math.max(expectedWords.size, actualWords.size)) * 60)
}

function parsePlainLyrics(input: unknown) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
