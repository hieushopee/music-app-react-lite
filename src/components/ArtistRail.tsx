import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { fetchArtistProfile, searchMusic, type ArtistProfile } from '../services/musicApi'
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
  'Bruno Mars',
  'Billie Eilish',
  'Dua Lipa',
  'Ed Sheeran',
  'Justin Bieber',
  'Adele',
  'Lana Del Rey',
  'Olivia Rodrigo',
  'Sabrina Carpenter',
  'Post Malone',
  'Coldplay',
  'Maroon 5',
  'Imagine Dragons',
  'OneRepublic',
  'Blackpink',
  'BTS',
  'NewJeans',
  'IVE',
  'LE SSERAFIM',
  'Jungkook',
  'IU',
  'Taeyeon',
  'BigBang',
  '2NE1',
  'Hòa Minzy',
  'Văn Mai Hương',
  'Orange',
  'MCK',
  'Low G',
  'RPT MCK',
  'Binz',
  'JustaTee',
  'Rhymastic',
  'Andree Right Hand',
  'Suboi',
  'Miu Lê',
  'Chi Pu',
  'Trúc Nhân',
  'Đức Phúc',
  'Jack J97',
  'Quân A.P',
  'RHYDER',
  'Dương Domic',
  'Tage',
  'Obito',
  'Wxrdie',
  'T.R.I',
  'Madihu',
  'GREY D',
  'Tăng Phúc',
  'Pháo',
  'Lê Bảo Bình',
  'Khắc Việt',
  'Ưng Hoàng Phúc',
  'Phương Mỹ Chi',
  'Vũ Cát Tường',
  'Lynk Lee',
  'B Ray',
  'Masew',
  'K-ICM',
  'Hoaprox',
  'Alan Walker',
  'Avicii',
  'Martin Garrix',
  'Calvin Harris',
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
const ARTIST_BATCH_SIZE = 20
const ARTIST_LOAD_DELAY_MS = 900
const ARTIST_SCROLL_LOAD_OFFSET = 220
const artistProfileCache = new Map<string, Promise<ArtistProfile | null>>()

export function ArtistRail() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = usePlayer()
  const { actions } = state
  const currentTrack = getCurrentTrack(state)
  const listRef = useRef<HTMLDivElement>(null)
  const loadedQueryKeysRef = useRef(new Set<string>())
  const [artists, setArtists] = useState<ArtistProfile[]>([])
  const [visibleQueryCount, setVisibleQueryCount] = useState(ARTIST_BATCH_SIZE)
  const [loadingProfiles, setLoadingProfiles] = useState(false)
  const [loadingArtist, setLoadingArtist] = useState('')
  const [brokenImages, setBrokenImages] = useState<Record<string, boolean>>({})
  const [tooltip, setTooltip] = useState<{ name: string; y: number } | null>(null)

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

  useEffect(() => {
    loadedQueryKeysRef.current = new Set()
    setArtists([])
    setBrokenImages({})
    setVisibleQueryCount(ARTIST_BATCH_SIZE)
  }, [artistQueries, state.apiBase])

  const loadNextArtistBatch = useCallback(() => {
    setVisibleQueryCount((previous) => Math.min(previous + ARTIST_BATCH_SIZE, artistQueries.length))
  }, [artistQueries.length])

  useEffect(() => {
    let cancelled = false

    async function loadArtists() {
      const queries = artistQueries.slice(0, visibleQueryCount).filter((query) => {
        const key = normalizeArtistName(query)
        if (!key || loadedQueryKeysRef.current.has(key)) return false
        loadedQueryKeysRef.current.add(key)
        return true
      })

      if (!queries.length) return

      setLoadingProfiles(true)

      try {
        const profiles = await Promise.allSettled(
          queries.map(async (query) => {
            try {
              return await fetchCachedArtistProfile(query, state.apiBase)
            } catch {
              return null
            }
          })
        )

        if (cancelled) return

        setArtists((previous) =>
          dedupeArtistProfiles([
            ...previous,
            ...profiles
              .map((result) => (result.status === 'fulfilled' ? result.value : null))
              .filter((artist): artist is ArtistProfile => Boolean(artist))
              .filter((artist) => isLikelyArtistName(artist.name) && Boolean(artist.thumbnail)),
          ])
        )
      } finally {
        if (!cancelled) {
          setLoadingProfiles(false)
        }
      }
    }

    const timer = window.setTimeout(() => {
      loadArtists()
    }, ARTIST_LOAD_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [artistQueries, state.apiBase, visibleQueryCount])

  const activeQuery = useMemo(() => normalizeArtistName(state.lastQuery), [state.lastQuery])
  const currentArtistKeys = useMemo(
    () => collectArtistQueries([currentTrack?.artist]).map(normalizeArtistName),
    [currentTrack?.artist]
  )
  const visibleArtists = useMemo(
    () => artists.filter((artist) => artist.thumbnail && !brokenImages[artist.id]),
    [artists, brokenImages]
  )
  const hasMoreArtists = visibleQueryCount < artistQueries.length

  function handleListScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight

    if (remaining <= ARTIST_SCROLL_LOAD_OFFSET && hasMoreArtists && !loadingProfiles) {
      loadNextArtistBatch()
    }
  }

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
      <div ref={listRef} className="artist-rail__list" onScroll={handleListScroll}>
        {visibleArtists.map((artist) => {
          const artistKey = normalizeArtistName(artist.name)
          const isCurrent = currentArtistKeys.some((key) => key === artistKey || key.includes(artistKey) || artistKey.includes(key))
          const isActive = !isCurrent && activeQuery === normalizeArtistName(artist.query)
          const isLoading = loadingArtist === artist.query

          return (
            <button
              key={artist.id}
              type="button"
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
                <img
                  src={artist.thumbnail}
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
              </span>

              {isCurrent ? <span className="artist-rail__pulse" aria-hidden="true" /> : null}
            </button>
          )
        })}
        {loadingProfiles ? <div className="artist-rail__loader" aria-hidden="true" /> : null}
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

function dedupeArtistProfiles(list: ArtistProfile[]) {
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()

  return list.filter((artist) => {
    const idKey = normalizeArtistName(artist.id)
    const nameKey = normalizeArtistName(artist.name)
    const queryKey = normalizeArtistName(artist.query)

    if ((idKey && seenIds.has(idKey)) || (nameKey && seenNames.has(nameKey))) {
      return false
    }

    if (!artist.thumbnail && queryKey && seenNames.has(queryKey)) {
      return false
    }

    if (idKey) seenIds.add(idKey)
    if (nameKey) seenNames.add(nameKey)
    if (queryKey) seenNames.add(queryKey)

    return true
  })
}

function getArtistCacheKey(query: string, apiBase: string) {
  return `${apiBase || '/api'}:${normalizeArtistName(query)}`
}

function fetchCachedArtistProfile(query: string, apiBase: string) {
  const cacheKey = getArtistCacheKey(query, apiBase)
  const cached = artistProfileCache.get(cacheKey)
  if (cached) return cached

  const request = fetchArtistProfile(query, apiBase).catch(() => null)
  artistProfileCache.set(cacheKey, request)

  if (artistProfileCache.size > 160) {
    const firstKey = artistProfileCache.keys().next().value
    if (firstKey) artistProfileCache.delete(firstKey)
  }

  return request
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
