import { startTransition, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Track, Album } from '../services/musicApi'
import { searchMusic, searchAlbums, getSearchSuggestions } from '../services/musicApi'
import { SectionBlock } from '../components/SectionBlock'
import { AlbumCard } from '../components/AlbumCard'
import { formatDuration } from '../lib/format'
import { getCoverStyle } from '../lib/cover'
import { usePlayer } from '../store/player'

const quickQueries = ['Nhac tre 2026', 'V-Pop chill', 'US UK acoustic', 'Lofi Viet', 'EDM workout']

const albumQueries = [
  'Vpop album hay nhất',
  'Son Tung MTP album',
  'Đen Vâu album',
  'Hà Anh Tuấn album',
  'Hoàng Dũng album',
  'Vũ album',
  'Tóc Tiên album',
  'Ngọt album',
  'Chillies album',
  'Da LAB album'
]

const sectionQueries = [
  { key: 'pulse', title: 'Nhịp phổ biến', subtitle: 'Chọn nhanh từ YouTube Music', queries: ['Top hits Vietnam 2026', 'Nhạc trẻ hot tiktok', 'Vpop mới nhất', 'Nhạc trẻ remix hay nhất'] },
  { key: 'night', title: 'Buổi tối nhẹ', subtitle: 'Nghe dài và thư giãn', queries: ['Chill acoustic vietnam', 'Lofi viet chill', 'Nhạc không lời thư giãn', 'Acoustic cover hay nhất'] },
  { key: 'motion', title: 'Tăng năng lượng', subtitle: 'Danh mục cho lúc di chuyển', queries: ['Workout music mix', 'EDM viet remix', 'Nhạc chạy bộ', 'Vinahouse 2026'] },
]

function shuffle<T>(array: T[]): T[] {
  const arr = [...array]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function CurrentStrip() {
  const navigate = useNavigate()
  const currentTrack = usePlayer(s => s.currentTrack)
  const progress = usePlayer(s => s.progress)
  const duration = usePlayer(s => s.duration)

  if (!currentTrack) return null

  return (
    <section className="current-strip">
      <div className="current-strip__art" style={getCoverStyle(currentTrack.thumbnail)} />
      <div className="current-strip__meta">
        <span>Đang phát</span>
        <h3>{currentTrack.title}</h3>
        <p>
          {currentTrack.artist} · {formatDuration(progress)} / {formatDuration(duration || currentTrack.duration)}
        </p>
      </div>
      <button type="button" className="action-pill" onClick={() => navigate('/player')}>
        Mở player
      </button>
    </section>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const actions = usePlayer(s => s.actions)
  const currentTrack = usePlayer(s => s.currentTrack)
  const lastQuery = usePlayer(s => s.lastQuery)
  const apiBase = usePlayer(s => s.apiBase)
  const favorites = usePlayer(s => s.favorites)
  const history = usePlayer(s => s.history)
  const queue = usePlayer(s => s.queue)
  const recentSearches = usePlayer(s => s.recentSearches)
  const lastResults = usePlayer(s => s.lastResults)
  
  const state = { lastQuery, apiBase, favorites, history, queue, recentSearches, lastResults }
  const [query, setQuery] = useState(state.lastQuery)
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [sections, setSections] = useState<Record<string, Track[]>>({})
  const [loadingSections, setLoadingSections] = useState(true)
  const [sectionsError, setSectionsError] = useState('')
  const [albums, setAlbums] = useState<Album[]>([])
  const [loadingAlbums, setLoadingAlbums] = useState(true)
  const albumGridRef = useRef<HTMLDivElement>(null)

  const favoriteIds = new Set(state.favorites.map((track) => track.id))

  useEffect(() => {
    setQuery(state.lastQuery)
  }, [state.lastQuery])

  // Debounced suggestions
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSuggestions([])
      return
    }
    const timer = setTimeout(async () => {
      const results = await getSearchSuggestions(trimmed, state.apiBase)
      setSuggestions(results)
    }, 300)
    return () => clearTimeout(timer)
  }, [query, state.apiBase])

  useEffect(() => {
    let cancelled = false

    async function loadAlbums() {
      setLoadingAlbums(true)
      try {
        const allAlbums: Album[] = []
        const seen = new Set<string>()

        const selectedQueries = shuffle(albumQueries).slice(0, 3)
        const results = await Promise.all(
          selectedQueries.map((q) => searchAlbums(q, state.apiBase))
        )

        for (const batch of results) {
          for (const album of batch) {
            if (!seen.has(album.albumId)) {
              seen.add(album.albumId)
              allAlbums.push(album)
            }
          }
        }

        if (!cancelled) {
          startTransition(() => {
            setAlbums(shuffle(allAlbums).slice(0, 20))
          })
        }
      } catch {
        // Ignore album loading errors
      } finally {
        if (!cancelled) setLoadingAlbums(false)
      }
    }

    loadAlbums()
    return () => { cancelled = true }
  }, [state.apiBase])

  useEffect(() => {
    let cancelled = false

    async function loadSections() {
      setLoadingSections(true)
      setSectionsError('')

      try {
        const results = await Promise.all(
          sectionQueries.map(async (section) => {
            const randomQuery = section.queries[Math.floor(Math.random() * section.queries.length)]
            const items = await searchMusic(randomQuery, state.apiBase)
            return [section.key, shuffle(items).slice(0, 20)] as const
          })
        )

        if (cancelled) return

        startTransition(() => {
          setSections(Object.fromEntries(results))
        })
      } catch {
        if (!cancelled) {
          startTransition(() => {
            setSections({})
            setSectionsError('Đã kết nối được backend nhưng không tải được danh mục nhạc. Hãy kiểm tra lại URL API hoặc khả năng tìm nhạc của server trong phần Cài đặt.')
          })
        }
      } finally {
        if (!cancelled) {
          setLoadingSections(false)
        }
      }
    }

    loadSections()

    return () => {
      cancelled = true
    }
  }, [state.apiBase])

  async function refreshAlbums() {
    setLoadingAlbums(true)
    try {
      const allAlbums: Album[] = []
      const seen = new Set<string>()
      const selectedQueries = shuffle(albumQueries).slice(0, 3)
      const results = await Promise.all(
        selectedQueries.map((q) => searchAlbums(q, state.apiBase))
      )
      for (const batch of results) {
        for (const album of batch) {
          if (!seen.has(album.albumId)) {
            seen.add(album.albumId)
            allAlbums.push(album)
          }
        }
      }
      setAlbums(shuffle(allAlbums).slice(0, 20))
    } catch {
      // ignore
    } finally {
      setLoadingAlbums(false)
    }
  }

  async function refreshSection(sectionKey: string) {
    setSections((prev) => ({ ...prev, [sectionKey]: [] }))
    try {
      const section = sectionQueries.find(s => s.key === sectionKey)
      if (!section) return
      const randomQuery = section.queries[Math.floor(Math.random() * section.queries.length)]
      const items = await searchMusic(randomQuery, state.apiBase)
      setSections((prev) => ({ ...prev, [sectionKey]: shuffle(items).slice(0, 20) }))
    } catch {
      // ignore
    }
  }

  async function handleSearch(submittedQuery?: string) {
    const keyword = String(submittedQuery ?? query).trim()
    if (!keyword) return

    setIsSearching(true)
    setSearchError('')

    try {
      const results = await searchMusic(keyword, state.apiBase)
      actions.setLastSearch(keyword, results)
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Không thể tìm kiếm nhạc lúc này.')
    } finally {
      setIsSearching(false)
    }
  }

  function playTrack(track: Track, queue: Track[]) {
    actions.playTrack(track, queue)
    navigate('/player')
  }

  function handleAlbumClick(album: Album) {
    if (album.albumId) {
      navigate(`/album/${encodeURIComponent(album.albumId)}`)
    }
  }

  function scrollAlbumGrid(direction: 'left' | 'right') {
    if (!albumGridRef.current) return
    const scrollAmount = Math.max(260, albumGridRef.current.clientWidth * 0.75)
    albumGridRef.current.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' })
  }

  return (
    <div className="home-page">
      <section className="hero-panel">
        <div className="hero-copy">
          <span>Trình phát nhạc thế hệ mới</span>
          <h2>Trải nghiệm âm nhạc không giới hạn.</h2>
          <p>
            Khám phá kho nhạc khổng lồ với hàng triệu bài hát. Tận hưởng không gian nghe nhạc mượt mà, tối giản và hoàn toàn tập trung vào cảm xúc của riêng bạn.
          </p>

          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault()
              handleSearch()
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="text"
              placeholder="Tìm bài hát, nghệ sĩ hoặc playlist..."
            />
            <button type="submit" disabled={isSearching}>
              {isSearching ? 'Đang tìm...' : 'Tìm nhạc'}
            </button>
          </form>

          <div className="chip-row">
            {query.trim()
              ? suggestions.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="query-chip"
                    onClick={() => {
                      setQuery(chip)
                      handleSearch(chip)
                    }}
                  >
                    {chip}
                  </button>
                ))
              : state.recentSearches.length > 0
                ? state.recentSearches.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="query-chip recent-chip"
                      onClick={() => {
                        setQuery(chip)
                        handleSearch(chip)
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
                      {chip}
                    </button>
                  ))
                : quickQueries.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="query-chip"
                      onClick={() => {
                        setQuery(chip)
                        handleSearch(chip)
                      }}
                    >
                      {chip}
                    </button>
                  ))
            }
          </div>

          {searchError ? <p className="feedback error">{searchError}</p> : null}
          {sectionsError ? <p className="feedback error">{sectionsError}</p> : null}
        </div>

        <div className="hero-status">
          <div className="status-card">
            <span>Nghe gần đây</span>
            <strong>{state.history.length} bài</strong>
          </div>
          <div className="status-card">
            <span>Yêu thích</span>
            <strong>{state.favorites.length} bài</strong>
          </div>
          <div className="status-card">
            <span>Đang chờ</span>
            <strong>{state.queue.length} bài</strong>
          </div>
        </div>
      </section>

      <CurrentStrip />

      {state.lastResults.length ? (
        <SectionBlock
          title={state.lastQuery || 'Kết quả gần nhất'}
          subtitle="Từ khóa vừa tìm"
          tracks={state.lastResults.slice(0, 30)}
          activeTrackId={currentTrack?.id || ''}
          favoriteIds={favoriteIds}
          emptyLabel="Chưa có kết quả tìm kiếm."
          onPlayTrack={playTrack}
          onToggleFavorite={actions.toggleFavorite}
        />
      ) : null}

      {/* Album nổi tiếng - Đĩa nhạc cho bạn */}
      <section className="section-block">
        <div className="section-head">
          <div>
            <span>Đĩa nhạc cho bạn</span>
            <h2>Album nổi tiếng</h2>
          </div>
          <div className="section-nav">
            <button type="button" onClick={refreshAlbums} aria-label="Làm mới">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <button type="button" onClick={() => scrollAlbumGrid('left')} aria-label="Cuộn trái">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <button type="button" onClick={() => scrollAlbumGrid('right')} aria-label="Cuộn phải">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>

        {loadingAlbums ? (
          <div className="album-grid" ref={albumGridRef}>
            {[...Array(8)].map((_, i) => (
              <div key={i} className="album-card" style={{ opacity: 0.4 }}>
                <div className="album-card__cover skeleton-item" />
                <div className="album-card__meta">
                  <div className="skeleton-item skeleton-item--text" style={{ width: '80%' }} />
                  <div className="skeleton-item skeleton-item--text" style={{ width: '50%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : albums.length ? (
          <div className="album-grid" ref={albumGridRef}>
            {albums.map((album) => (
              <AlbumCard key={album.albumId} album={album} onClick={() => handleAlbumClick(album)} />
            ))}
          </div>
        ) : (
          <div className="empty-panel">Không tải được danh sách album.</div>
        )}
      </section>

      {state.favorites.length ? (
        <SectionBlock
          title="Bài hát bạn đã thích"
          subtitle="Có thể mở lại rất nhanh"
          tracks={state.favorites.slice(0, 20)}
          activeTrackId={currentTrack?.id || ''}
          favoriteIds={favoriteIds}
          emptyLabel="Chưa có bài yêu thích."
          onPlayTrack={playTrack}
          onToggleFavorite={actions.toggleFavorite}
        />
      ) : null}

      <SectionBlock
        title="Nghe gần đây"
        subtitle="Lịch sử của bạn"
        tracks={state.history.slice(0, 20)}
        activeTrackId={currentTrack?.id || ''}
        favoriteIds={favoriteIds}
        emptyLabel="Lịch sử sẽ xuất hiện sau khi bạn phát bài đầu tiên."
        onPlayTrack={playTrack}
        onToggleFavorite={actions.toggleFavorite}
      />

      {sectionQueries.map((section) => (
        <SectionBlock
          key={section.key}
          title={section.title}
          subtitle={section.subtitle}
          tracks={sections[section.key] || []}
          activeTrackId={currentTrack?.id || ''}
          favoriteIds={favoriteIds}
          loading={loadingSections && (!sections[section.key] || sections[section.key].length === 0)}
          emptyLabel="Không tải được danh mục này."
          onPlayTrack={playTrack}
          onToggleFavorite={actions.toggleFavorite}
          onRefresh={() => refreshSection(section.key)}
        />
      ))}
    </div>
  )
}
