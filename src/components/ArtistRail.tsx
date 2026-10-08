import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { fetchArtistProfile, searchMusic, type ArtistProfile, type Track } from '../services/musicApi'
import { usePlayer, getCurrentTrack } from '../store/player'

const ARTIST_SHORTCUTS = [
  'Sơn Tùng M-TP',
  'Mỹ Tâm',
  'SOOBIN',
  'Đen Vâu',
  'HIEUTHUHAI',
  'Hà Anh Tuấn',
  'Bích Phương',
  'Tăng Duy Tân',
  'MONO',
  'Min',
  'ERIK',
  'AMEE',
  'Karik',
  'Phan Mạnh Quỳnh',
  'Vũ.',
  'Tlinh',
  'Phương Ly',
  'Hoàng Dũng',
  'Noo Phước Thịnh',
  'Wren Evans',
  'Charlie Puth',
  'Ariana Grande',
  'Taylor Swift',
  'The Weeknd',
]

const BLOCKED_ARTIST_TERMS = [
  'remix',
  'reup',
  're up',
  'slowed',
  'reverb',
  'nightcore',
  'lyrics',
  'lyric',
  'official audio',
  'official',
  'topic',
  'channel',
  'music',
  'records',
  'entertainment',
  'media',
  'studio',
  'production',
  'audio',
  'tv',
  'fm',
]

const SHORT_ARTIST_ALLOWLIST = new Set(['vu'])
const ARTIST_PROFILE_CACHE_KEY = 'pulseframe-artist-profile-cache-v1'
const ARTIST_PROFILE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const MAX_ARTIST_PROFILE_LOOKUPS_PER_LOAD = 6

interface CachedArtistProfile {
  expiresAt: number
  thumbnail: string
}

export function ArtistRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = usePlayer()
  const { actions } = state
  const currentTrack = getCurrentTrack(state)
  const [loadingArtist, setLoadingArtist] = useState('')
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({})
  const [profileThumbnails, setProfileThumbnails] = useState<Record<string, string>>({})
  const [tooltip, setTooltip] = useState<{ name: string; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const artistQueries = useMemo(() => {
    const dynamicArtists = collectArtistQueries([
      currentTrack?.artist,
      ...state.history.map((track) => track.artist),
      ...state.favorites.map((track) => track.artist),
      ...state.queue.map((track) => track.artist),
      ...state.lastResults.map((track) => track.artist),
    ])

    const seen = new Set<string>()
    const merged = [...dynamicArtists, ...ARTIST_SHORTCUTS].filter(isLikelyArtistName)

    return merged.filter((artist) => {
      const key = normalizeArtistName(artist)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [currentTrack?.artist, state.history, state.favorites, state.queue, state.lastResults])

  const artists = useMemo(() => {
    const tracks: Track[] = [currentTrack, ...state.history, ...state.favorites, ...state.queue, ...state.lastResults]
      .filter((track): track is Track => Boolean(track))

    return artistQueries.map((query) => ({
      id: normalizeArtistName(query),
      name: query,
      query,
      thumbnail: findArtistThumbnail(query, tracks),
    }))
  }, [artistQueries, currentTrack, state.history, state.favorites, state.queue, state.lastResults])

  const activeQuery = useMemo(() => normalizeArtistName(state.lastQuery), [state.lastQuery])
  const currentArtistKeys = useMemo(
    () => collectArtistQueries([currentTrack?.artist]).map(normalizeArtistName),
    [currentTrack?.artist]
  )
  const visibleArtists = artists

  useEffect(() => {
    const list = listRef.current
    if (!list || typeof IntersectionObserver === 'undefined') return

    let cancelled = false
    let isLoading = false
    let lookupCount = 0
    const pendingQueries: Array<{ id: string; query: string }> = []
    const queuedIds = new Set<string>()

    async function loadNextProfile() {
      if (isLoading || cancelled) return

      const next = pendingQueries.shift()
      if (!next) return
      isLoading = true

      try {
        const profile = await fetchArtistProfile(next.query, state.apiBase)
        const thumbnail = profile?.thumbnail || ''
        saveCachedArtistProfile(next.query, thumbnail)
        if (thumbnail && !cancelled) {
          setProfileThumbnails((previous) => ({ ...previous, [next.id]: thumbnail }))
        }
      } catch {
        // Keep the existing track-cover or initial fallback if profile lookup fails.
      } finally {
        isLoading = false
        void loadNextProfile()
      }
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const element = entry.target as HTMLElement
        const id = element.dataset.artistId || ''
        const query = element.dataset.artistQuery || ''
        if (!id || !query || queuedIds.has(id)) continue

        observer.unobserve(element)
        queuedIds.add(id)
        const cachedThumbnail = readCachedArtistProfile(query)
        if (cachedThumbnail !== undefined) {
          if (cachedThumbnail) {
            setProfileThumbnails((previous) => ({ ...previous, [id]: cachedThumbnail }))
          }
          continue
        }

        if (lookupCount >= MAX_ARTIST_PROFILE_LOOKUPS_PER_LOAD) continue
        lookupCount += 1
        pendingQueries.push({ id, query })
      }

      void loadNextProfile()
    }, { root: list, rootMargin: '80px 0px' })

    for (const element of list.querySelectorAll<HTMLElement>('[data-artist-id]')) {
      observer.observe(element)
    }

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [artists, state.apiBase])

  async function handleArtistSelect(artist: ArtistProfile) {
    setLoadingArtist(artist.query)

    try {
      const results = await searchMusic(artist.query, state.apiBase)
      actions.setLastSearch(artist.query, results)

      if (location.pathname !== '/') {
        navigate('/')
      }

      window.scrollTo({ top: 0, behavior: 'smooth' })
    } finally {
      setLoadingArtist('')
    }
  }

  return (
    <aside className="artist-rail" aria-label="Danh sách ca sĩ">
      <div className="artist-rail__list" ref={listRef}>
        {visibleArtists.map((artist) => {
          const artistKey = normalizeArtistName(artist.name)
          const isCurrent = currentArtistKeys.some((key) => key === artistKey || key.includes(artistKey) || artistKey.includes(key))
          const isActive = !isCurrent && activeQuery === normalizeArtistName(artist.query)
          const isLoading = loadingArtist === artist.query
          const thumbnail = profileThumbnails[artist.id] || artist.thumbnail

          return (
            <button
              key={artist.id}
              type="button"
              data-artist-id={artist.id}
              data-artist-query={artist.query}
              className={`artist-rail__button${isActive ? ' is-active' : ''}${isCurrent ? ' is-current' : ''}${isLoading ? ' is-loading' : ''}`}
              onClick={() => handleArtistSelect(artist)}
              aria-label={`Mở nhạc của ${artist.name}`}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
                setTooltip({ name: artist.name, y: rect.top + rect.height / 2 })
              }}
              onMouseLeave={() => setTooltip(null)}
            >
              <span className="artist-rail__avatar">
                {thumbnail && !brokenImages[artist.id] ? (
                  <img
                    src={thumbnail}
                    alt={artist.name}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => {
                      setBrokenImages((previous) => ({
                        ...previous,
                        [artist.id]: true,
                      }))
                    }}
                  />
                ) : (
                  <span className="artist-rail__fallback" aria-hidden="true">{artist.name.slice(0, 1).toUpperCase()}</span>
                )}
              </span>

              {isCurrent ? <span className="artist-rail__pulse" aria-hidden="true" /> : null}
            </button>
          )
        })}
      </div>

      {tooltip ? (
        <div
          className="artist-rail__tooltip"
          style={{ top: tooltip.y }}
          aria-hidden="true"
        >
          {tooltip.name}
        </div>
      ) : null}
    </aside>
  )
}

function readCachedArtistProfile(query: string) {
  if (typeof window === 'undefined') return undefined

  try {
    const cache = JSON.parse(window.localStorage.getItem(ARTIST_PROFILE_CACHE_KEY) || '{}') as Record<string, CachedArtistProfile>
    const key = normalizeArtistName(query)
    const entry = cache[key]
    if (entry && entry.expiresAt > Date.now()) return entry.thumbnail
  } catch {
    return undefined
  }

  return undefined
}

function saveCachedArtistProfile(query: string, thumbnail: string) {
  if (typeof window === 'undefined') return

  try {
    const cache = JSON.parse(window.localStorage.getItem(ARTIST_PROFILE_CACHE_KEY) || '{}') as Record<string, CachedArtistProfile>
    const key = normalizeArtistName(query)
    cache[key] = { expiresAt: Date.now() + ARTIST_PROFILE_CACHE_TTL, thumbnail }
    window.localStorage.setItem(ARTIST_PROFILE_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Profile caching is optional; the rail still works without local storage.
  }
}

function findArtistThumbnail(query: string, tracks: Track[]) {
  const artistKey = normalizeArtistName(query)
  const track = tracks.find((item) => {
    const trackKey = normalizeArtistName(item.artist)
    return trackKey === artistKey || trackKey.includes(artistKey) || artistKey.includes(trackKey)
  })

  return track?.thumbnail || track?.sourceThumbnail || ''
}

function collectArtistQueries(values: Array<string | null | undefined>) {
  const output: string[] = []

  for (const value of values) {
    const raw = String(value || '').trim()
    if (!raw) continue

    for (const artist of splitArtistNames(raw)) {
      if (!isLikelyArtistName(artist)) continue
      output.push(artist)
    }
  }

  return output
}

function splitArtistNames(value: string) {
  return String(value || '')
    .split(/\s*(?:,|&|\/|\||;|\bx\b|\bft\.?\b|\bfeat\.?\b|\bfeaturing\b|\bvs\.?\b)\s*/i)
    .map(cleanArtistName)
    .filter(Boolean)
}

function cleanArtistName(value: string) {
  return String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+-\s+topic$/i, '')
    .replace(/\s+-\s+official.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isLikelyArtistName(value: string) {
  const raw = String(value || '').trim()
  const normalized = normalizeArtistName(raw)

  if (!normalized) return false
  if (normalized.length <= 2 && !SHORT_ARTIST_ALLOWLIST.has(normalized)) return false
  if (/^\d+$/.test(normalized)) return false

  for (const blocked of BLOCKED_ARTIST_TERMS) {
    if (normalized.includes(blocked)) return false
  }

  return true
}

function normalizeArtistName(value: string) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
