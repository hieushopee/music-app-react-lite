import type { Track } from '../services/musicApi'
import { getConfiguredApiBase } from '../services/musicApi'
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
        <a 
          href={`${getConfiguredApiBase()}/api/download?videoId=${track.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="action-chip action-chip--icon" 
          aria-label="Tải xuống audio"
          onClick={(e) => e.stopPropagation()}
        >
          <svg style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
      </div>
    </article>
  )
}
