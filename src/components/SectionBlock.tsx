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
}: SectionBlockProps) {
  return (
    <section className="section-block">
      <div className="section-head">
        <div>
          <span>{subtitle}</span>
          <h2>{title}</h2>
        </div>
      </div>

      {loading ? (
        <div className="song-grid song-grid--compact">
          {[...Array(6)].map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : tracks.length ? (
        <div className={`song-grid${tracks.length <= 2 ? ' song-grid--compact' : ''}`}>
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
