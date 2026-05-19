import { startTransition, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Track } from '../services/musicApi'
import { searchMusic } from '../services/musicApi'
import { SectionBlock } from '../components/SectionBlock'
import { formatDuration } from '../lib/format'
import { getCoverStyle } from '../lib/cover'
import { usePlayer } from '../store/player'

const quickQueries = ['Nhac tre 2026', 'V-Pop chill', 'US UK acoustic', 'Lofi Viet', 'EDM workout']

const sectionQueries = [
  { key: 'pulse', title: 'Nhịp phổ biến', subtitle: 'Chọn nhanh từ YouTube Music', query: 'Top hits Vietnam 2026' },
  { key: 'night', title: 'Buổi tối nhẹ', subtitle: 'Nghe dài và thư giãn', query: 'Chill acoustic vietnam' },
  { key: 'motion', title: 'Tăng năng lượng', subtitle: 'Danh mục cho lúc di chuyển', query: 'Workout music mix' },
]

export function HomePage() {
  const navigate = useNavigate()
  const { state, currentTrack, actions } = usePlayer()
  const [query, setQuery] = useState(state.lastQuery)
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [sections, setSections] = useState<Record<string, Track[]>>({})
  const [loadingSections, setLoadingSections] = useState(true)
  const [sectionsError, setSectionsError] = useState('')

  const favoriteIds = new Set(state.favorites.map((track) => track.id))

  useEffect(() => {
    setQuery(state.lastQuery)
  }, [state.lastQuery])

  useEffect(() => {
    let cancelled = false

    async function loadSections() {
      setLoadingSections(true)
      setSectionsError('')

      try {
        const results = await Promise.all(
          sectionQueries.map(async (section) => {
            const items = await searchMusic(section.query, state.apiBase)
            return [section.key, items.slice(0, 6)] as const
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

  return (
    <div className="home-page">
      <section className="hero-panel">
        <div className="hero-copy">
          <span>Trình phát nhạc thế hệ mới</span>
          <h2>Không gian âm nhạc tối giản & thuần khiết.</h2>
          <p>
            Tận hưởng hàng triệu bài hát với chất lượng cao nhất, giao diện tập trung hoàn toàn vào cảm xúc và nghệ thuật của
            người nghệ sĩ.
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
            {quickQueries.map((chip) => (
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
            ))}
          </div>

          {searchError ? <p className="feedback error">{searchError}</p> : null}
          {sectionsError ? <p className="feedback error">{sectionsError}</p> : null}
        </div>

        <div className="hero-status">
          <div className="status-card">
            <span>Đang chờ</span>
            <strong>{state.queue.length} bài</strong>
          </div>
          <div className="status-card">
            <span>Yêu thích</span>
            <strong>{state.favorites.length} bài</strong>
          </div>
          <div className="status-card">
            <span>Đã nghe</span>
            <strong>{state.history.length} bài</strong>
          </div>
        </div>
      </section>

      {currentTrack ? (
        <section className="current-strip">
          <div className="current-strip__art" style={getCoverStyle(currentTrack.thumbnail)} />
          <div className="current-strip__meta">
            <span>Đang phát</span>
            <h3>{currentTrack.title}</h3>
            <p>
              {currentTrack.artist} · {formatDuration(state.progress)} / {formatDuration(state.duration || currentTrack.duration)}
            </p>
          </div>
          <button type="button" className="action-pill" onClick={() => navigate('/player')}>
            Mở player
          </button>
        </section>
      ) : null}

      {state.lastResults.length ? (
        <SectionBlock
          title={state.lastQuery || 'Kết quả gần nhất'}
          subtitle="Từ khóa vừa tìm"
          tracks={state.lastResults.slice(0, 12)}
          activeTrackId={currentTrack?.id || ''}
          favoriteIds={favoriteIds}
          emptyLabel="Chưa có kết quả tìm kiếm."
          onPlayTrack={playTrack}
          onToggleFavorite={actions.toggleFavorite}
        />
      ) : null}

      {state.favorites.length ? (
        <SectionBlock
          title="Bài hát bạn đã thích"
          subtitle="Có thể mở lại rất nhanh"
          tracks={state.favorites.slice(0, 8)}
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
        tracks={state.history.slice(0, 8)}
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
        />
      ))}
    </div>
  )
}
