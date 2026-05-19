import { useEffect, useRef } from 'react'
import type { LyricLine } from '../lib/lyrics'

interface LyricsViewProps {
  lines: LyricLine[]
  activeIndex: number
  loading: boolean
  error: string
  synced: boolean
  onSeekLine?: (line: LyricLine) => void
}

export function LyricsView({ lines, activeIndex, loading, error, synced, onSeekLine }: LyricsViewProps) {
  const wallRef = useRef<HTMLDivElement | null>(null)
  const refs = useRef<Array<HTMLElement | null>>([])

  useEffect(() => {
    if (activeIndex < 0) return
    const wall = wallRef.current
    const activeLine = refs.current[activeIndex]
    const scrollContainer = wall?.parentElement
    if (!wall || !activeLine || !scrollContainer) return

    const currentScrollTop = scrollContainer.scrollTop
    const viewportHeight = scrollContainer.clientHeight
    const finalScrollTop = Math.max(scrollContainer.scrollHeight - scrollContainer.clientHeight, 0)
    const lineTop = activeLine.offsetTop
    const lineHeight = activeLine.offsetHeight
    const topTarget = lineTop - 28
    const idealScrollTop = activeIndex <= 1 ? topTarget : lineTop - viewportHeight * 0.46 + lineHeight / 2
    const nextScrollTop = Math.max(0, Math.min(idealScrollTop, finalScrollTop))
    if (Math.abs(nextScrollTop - currentScrollTop) < 8) return

    scrollContainer.scrollTo({
      top: nextScrollTop,
      behavior: 'smooth',
    })
  }, [activeIndex, lines.length])

  if (loading) {
    return <div className="lyrics-placeholder">Đang tải lời nhạc...</div>
  }

  if (error) {
    return <div className="lyrics-placeholder">{error}</div>
  }

  if (!lines.length) {
    return <div className="lyrics-placeholder">Chưa có lời nhạc cho bài này.</div>
  }

  return (
    <div ref={wallRef} className="lyrics-wall">
      {lines.map((line, index) => {
        const className = `lyrics-line${!synced ? ' is-static' : ''}${synced ? ' is-interactive' : ''}${index === activeIndex ? ' is-active' : ''}${index < activeIndex ? ' is-past' : ''}`

        if (synced) {
          return (
            <button
              key={`${line.start}-${index}`}
              type="button"
              ref={(element) => {
                refs.current[index] = element
              }}
              className={className}
              onClick={() => onSeekLine?.(line)}
            >
              {line.text}
            </button>
          )
        }

        return (
          <p
            key={`${line.start}-${index}`}
            ref={(element) => {
              refs.current[index] = element
            }}
            className={className}
          >
            {line.text}
          </p>
        )
      })}
    </div>
  )
}
