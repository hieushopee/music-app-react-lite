import type { CSSProperties } from 'react'

interface SkeletonLoaderProps {
  className?: string
  style?: CSSProperties
}

export function SkeletonLoader({ className = '', style }: SkeletonLoaderProps) {
  return <div className={`skeleton-item ${className}`} style={style} aria-hidden="true" />
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <div className="skeleton-item skeleton-item--rect" />
      <div className="skeleton-card__meta">
        <div className="skeleton-item skeleton-item--text" style={{ width: '80%' }} />
        <div className="skeleton-item skeleton-item--text" style={{ width: '50%' }} />
      </div>
      <div className="skeleton-card__actions">
        <div className="skeleton-item skeleton-item--pill" />
        <div className="skeleton-item skeleton-item--pill" />
      </div>
    </div>
  )
}
