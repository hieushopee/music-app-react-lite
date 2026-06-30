import type { Album } from '../services/musicApi'

interface AlbumCardProps {
  album: Album
  onClick: () => void
}

export function AlbumCard({ album, onClick }: AlbumCardProps) {
  const coverStyle = album.thumbnail
    ? { backgroundImage: `url(${album.thumbnail})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: 'rgba(255,255,255,0.06)' }

  return (
    <article className="album-card" onClick={onClick}>
      <div className="album-card__cover" style={coverStyle} />
      <div className="album-card__meta">
        <h3 className="album-card__title">{album.name}</h3>
        <p className="album-card__artist">
          {album.artist}
          {album.year ? ` · ${album.year}` : ''}
        </p>
      </div>
    </article>
  )
}
