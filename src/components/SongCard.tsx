import type { Track } from '../services/musicApi'
import { getCoverStyle } from '../lib/cover'
import { formatDuration } from '../lib/format'

interface SongCardProps {
  track: Track
  isActive: boolean
  isFavorite: boolean
  onPlay: () => void
  onToggleFavorite: () => void
}

export function SongCard({ track, isActive, isFavorite, onPlay, onToggleFavorite }: SongCardProps) {
  return (
    <article className={`song-card${isActive ? ' is-active' : ''}`}>
      <button type="button" className="song-card__cover" onClick={onPlay} style={getCoverStyle(track.thumbnail)}>
        <span className="song-card__play">▶</span>
      </button>

      <div className="song-card__meta">
        <div className="song-card__title-slot">
          <button type="button" className="song-card__title" onClick={onPlay}>
            {track.title}
          </button>
        </div>
        <p className="song-card__artist">{track.artist}</p>
        <span>{formatDuration(track.duration)}</span>
      </div>

      <div className="song-card__actions">
        <button type="button" className="action-chip" onClick={onPlay}>
          Phát
        </button>
        <button type="button" className={`action-chip${isFavorite ? ' is-active' : ''}`} onClick={onToggleFavorite}>
          {isFavorite ? 'Đã thích' : 'Yêu thích'}
        </button>
      </div>
    </article>
  )
}
