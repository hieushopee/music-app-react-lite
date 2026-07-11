import type { Track } from '../services/musicApi'
import { getCoverStyle } from '../lib/cover'
import { useLazyBackground } from '../lib/useLazyBackground'
import { formatDuration } from '../lib/format'

interface SongCardProps {
  track: Track
  isActive: boolean
  isFavorite: boolean
  onPlay: () => void
  onToggleFavorite: () => void
}

export function SongCard({ track, isActive, isFavorite, onPlay, onToggleFavorite }: SongCardProps) {
  const { ref, isVisible } = useLazyBackground(track.thumbnail)
  const coverStyle = isVisible ? getCoverStyle(track.thumbnail) : {}

  return (
    <article className={`song-card${isActive ? ' is-active' : ''}`}>
      <button type="button" className="song-card__cover" onClick={onPlay} style={coverStyle} ref={ref as React.RefObject<HTMLButtonElement>}>
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
          href={`https://music.youtube.com/watch?v=${track.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="action-chip action-chip--icon" 
          aria-label="Mở trên YouTube Music"
          onClick={(e) => e.stopPropagation()}
          title="Mở trên YouTube Music"
        >
          <svg style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </a>
      </div>
    </article>
  )
}
