import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePlayer } from '../store/player'
import { fetchAlbumDetail } from '../services/musicApi'
import type { AlbumDetail, Track } from '../services/musicApi'
import { getCoverStyle } from '../lib/cover'
import { formatDuration } from '../lib/format'

export function AlbumPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { state, actions } = usePlayer()
  
  const [album, setAlbum] = useState<AlbumDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function loadAlbum() {
      if (!id) return
      setLoading(true)
      setError('')
      try {
        const detail = await fetchAlbumDetail(id, state.apiBase)
        if (!cancelled) {
          setAlbum(detail)
        }
      } catch (err) {
        if (!cancelled) setError('Không thể tải thông tin album.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadAlbum()
    return () => { cancelled = true }
  }, [id, state.apiBase])

  const totalDuration = useMemo(() => {
    if (!album) return 0
    return album.songs.reduce((acc, song) => acc + song.duration, 0)
  }, [album])

  function handlePlayAll() {
    if (!album || !album.songs.length) return
    actions.playTrack(album.songs[0], album.songs)
    navigate('/player')
  }

  function handlePlayTrack(track: Track) {
    if (!album) return
    actions.playTrack(track, album.songs)
    navigate('/player')
  }

  if (loading) {
    return (
      <div className="album-page album-page--loading">
        <div className="skeleton-item skeleton-item--rect" style={{ width: '100%', maxWidth: '320px', margin: '0 auto' }} />
      </div>
    )
  }

  if (error || !album) {
    return (
      <div className="album-page">
        <p className="feedback error">{error || 'Không tìm thấy album.'}</p>
        <button type="button" className="action-pill" onClick={() => navigate(-1)}>Quay lại</button>
      </div>
    )
  }

  const coverStyle = album.thumbnail
    ? { backgroundImage: `url(${album.thumbnail})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: 'rgba(255,255,255,0.06)' }

  return (
    <div className="album-page">
      <div className="album-header">
        <div className="album-header__cover-wrapper">
          <div className="album-header__cover" style={coverStyle} />
        </div>
        <h1 className="album-header__title">{album.name}</h1>
        <p className="album-header__meta">
          Đĩa nhạc • {album.year || '2026'}<br />
          {album.songs.length} bài hát • {Math.floor(totalDuration / 60)} phút
        </p>
        
        <div className="album-header__actions">
          <button type="button" className="circle-btn" aria-label="Thêm vào thư viện">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          
          <button type="button" className="play-fab" onClick={handlePlayAll} aria-label="Phát toàn bộ">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
          </button>
          
          <button type="button" className="circle-btn" aria-label="Thêm tùy chọn">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
              <circle cx="5" cy="12" r="2" />
            </svg>
          </button>
        </div>
      </div>
      
      <div className="album-tracklist">
        {album.songs.map((song, index) => (
          <div 
            key={song.id} 
            className={`track-row ${state.currentTrackId === song.id ? 'is-active' : ''}`}
            onClick={() => handlePlayTrack(song)}
          >
            <div className="track-row__index">
              <span className="index-text">{index + 1}</span>
              <button 
                type="button" 
                className="index-play-btn"
                onClick={() => handlePlayTrack(song)}
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
              </button>
            </div>
            
            <div className="track-row__info">
              <h4 className="track-title">{song.title}</h4>
              {/* Optional: <p className="track-artist">{song.artist}</p> */}
            </div>
            
            <div className="track-row__duration">
              {formatDuration(song.duration)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
