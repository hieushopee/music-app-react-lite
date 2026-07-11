import type { Track } from '../services/musicApi'
import { getCoverStyle } from '../lib/cover'
import { useLazyBackground } from '../lib/useLazyBackground'
import { formatDuration } from '../lib/format'
import { usePlayer } from '../store/player'
import { useState } from 'react'

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
  const apiBase = usePlayer(s => s.apiBase)
  const localDownloadPath = usePlayer(s => s.localDownloadPath)
  const [isDownloading, setIsDownloading] = useState(false)

  const handleLocalDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    
    setIsDownloading(true)
    try {
      const res = await fetch(`${apiBase || ''}/api/save-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: track.id, savePath: localDownloadPath })
      })
      if (!res.ok) throw new Error('Download failed')
      alert(`Đã tải xong: ${track.title}`)
    } catch (err) {
      alert(`Lỗi tải xuống: ${track.title}`)
    } finally {
      setIsDownloading(false)
    }
  }

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
        
        {localDownloadPath ? (
          <button 
            type="button"
            className="action-chip action-chip--icon" 
            aria-label="Tải xuống (Local)"
            onClick={handleLocalDownload}
            disabled={isDownloading}
            title={`Sẽ tải trực tiếp vào ${localDownloadPath}`}
          >
            {isDownloading ? (
              <svg style={{ width: '16px', height: '16px', animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="2" x2="12" y2="6"></line>
                <line x1="12" y1="18" x2="12" y2="22"></line>
                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
                <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
                <line x1="2" y1="12" x2="6" y2="12"></line>
                <line x1="18" y1="12" x2="22" y2="12"></line>
                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
                <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
              </svg>
            ) : (
              <svg style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
          </button>
        ) : (
          <a 
            href={`${apiBase || ''}/api/download?videoId=${track.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="action-chip action-chip--icon" 
            aria-label="Tải xuống audio"
            onClick={(e) => e.stopPropagation()}
            title="Tải MP3"
          >
            <svg style={{ width: '16px', height: '16px' }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
    </article>
  )
}
