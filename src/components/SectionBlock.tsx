import { useRef } from 'react'
import type { Track } from '../services/musicApi'
import { SkeletonCard } from './SkeletonLoader'
import { SongCard } from './SongCard'

interface SectionBlockProps {
  title: string
  subtitle: string
  tracks: Track[]
  activeTrackId: string
  favoriteIds: Set<string>
  emptyLabel: string
  loading?: boolean
  onPlayTrack: (track: Track, queue: Track[]) => void
  onToggleFavorite: (track: Track) => void
  onRefresh?: () => void
}

export function SectionBlock({
  title,
  subtitle,
  tracks,
  activeTrackId,
  favoriteIds,
  emptyLabel,
  loading,
  onPlayTrack,
  onToggleFavorite,
  onRefresh,
}: SectionBlockProps) {
  const gridRef = useRef<HTMLDivElement>(null)

  function scrollGrid(direction: 'left' | 'right') {
    if (!gridRef.current) return
    const scrollAmount = Math.max(260, gridRef.current.clientWidth * 0.75)
    gridRef.current.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' })
  }

  return (
    <section className="section-block">
      <div className="section-head">
        <div>
          <span>{subtitle}</span>
          <h2>{title}</h2>
        </div>
        <div className="section-nav">
          {onRefresh && (
            <button type="button" onClick={onRefresh} aria-label="Làm mới">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          )}
          <button type="button" onClick={() => scrollGrid('left')} aria-label="Cuộn trái">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button type="button" onClick={() => scrollGrid('right')} aria-label="Cuộn phải">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="song-grid" ref={gridRef}>
          {[...Array(6)].map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : tracks.length ? (
        <div className="song-grid" ref={gridRef}>
          {tracks.map((track) => (
            <SongCard
              key={track.id}
              track={track}
              isActive={track.id === activeTrackId}
              isFavorite={favoriteIds.has(track.id)}
              onPlay={() => onPlayTrack(track, tracks)}
              onToggleFavorite={() => onToggleFavorite(track)}
            />
          ))}
        </div>
      ) : (
        <div className="empty-panel">{emptyLabel}</div>
      )}
    </section>
  )
}
