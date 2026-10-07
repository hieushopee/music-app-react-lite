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
      return json({ items: [] })
    }

    if (request.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q')?.trim() || ''
      if (!query) return json({ error: 'Missing q parameter' }, 400)
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
      return getPlaylists(env, url)
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/album/')) {
      return getPlaylistDetail(env, decodeURIComponent(url.pathname.slice('/api/album/'.length)))
    }

    return json({ error: 'Not found' }, 404)
  } catch (error) {
    console.error('API error:', error instanceof Error ? error.message : error)
    return json({ error: error instanceof Error ? error.message : 'Server error' }, 500)
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
  const remoteSynced = manualLines.length
    ? []
    : await fetchTimedLyrics({ title, artist, album: albumHint, duration })
  const merged = !manualSynced.length && manualLyrics.length ? mergeManualLyricsIntoSyncedLyrics(manualLyrics, remoteSynced) : []
  const syncedLyrics = manualSynced.length ? manualSynced : merged.length ? merged : manualLyrics.length ? [] : remoteSynced
  const lyrics = manualLyrics.length ? manualLyrics : syncedLyrics.map((line) => line.text)

  return json({
    lyrics,
    syncedLyrics,
    manualLines: manualDraftLines,
    lyricSource: manualLyrics.length || manualSynced.length ? 'manual' : syncedLyrics.length ? 'synced' : 'none',
    canManualSync: true,
    hasManualSync: Boolean(manualLyrics.length || manualLines.length),
    thumbnail: manualEntry?.thumbnail || '',
  })
}

async function getArtist(env: Env, url: URL) {
  const query = url.searchParams.get('q')?.trim() || ''
  if (!query) return json({ error: 'Missing q parameter' }, 400)

  const results = await requestYouTube(env, '/search', {
    part: 'snippet', q: query, type: 'channel', maxResults: 5, relevanceLanguage: 'vi',
  }, 12 * 60 * 60)
  const match = (results.items || []).map((item: any, index: number) => ({
    id: String(item.id?.channelId || ''),
    name: query,
    query,
    thumbnail: pickYouTubeThumbnail(item.snippet?.thumbnails),
    score: scoreArtistMatch(query, item.snippet?.title),
    index,
  })).filter((item: any) => item.id && item.thumbnail)
    .sort((a: any, b: any) => b.score - a.score || a.index - b.index)[0]

  return json({ item: match && match.score >= 120 ? { id: match.id, name: match.name, query: match.query, thumbnail: match.thumbnail } : null })
}

async function getPlaylists(env: Env, url: URL) {
  const query = url.searchParams.get('q')?.trim() || ''
  if (!query) return json({ error: 'Missing q parameter' }, 400)

  const results = await requestYouTube(env, '/search', {
    part: 'snippet', q: query, type: 'playlist', maxResults: 12, relevanceLanguage: 'vi',
  }, 60 * 60)
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
  }, 10 * 60)
  const ids = (results.items || []).map((item: any) => item.id?.videoId).filter(Boolean)
  if (!ids.length) return []
  const videos = await requestYouTube(env, '/videos', { part: 'snippet,contentDetails', id: ids.join(',') }, 10 * 60)
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

  const cache = await caches.open('youtube-data-api')
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

async function fetchTimedLyrics({ title, artist, album, duration }: { title: string; artist: string; album: string; duration: number }) {
  if (!title || !artist) return []
  const params = new URLSearchParams({ track_name: title, artist_name: artist })
  if (album) params.set('album_name', album)
  if (duration) params.set('duration', String(Math.round(duration)))

  try {
    const response = await fetch(`${LRCLIB_API_BASE}/get?${params.toString()}`)
    const item = await response.json<any>()
    if (response.ok && item?.syncedLyrics) return parseLrc(item.syncedLyrics)
  } catch {
    // Fall through to the search endpoint.
  }

  try {
    const response = await fetch(`${LRCLIB_API_BASE}/search?${params.toString()}`)
    const items = await response.json<any[]>()
    const best = Array.isArray(items) ? items.find((item) => item?.syncedLyrics) : null
    return best?.syncedLyrics ? parseLrc(best.syncedLyrics) : []
  } catch {
    return []
  }
}
