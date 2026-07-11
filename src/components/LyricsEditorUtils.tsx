import { formatDuration } from '../lib/format'

// ---- Utility functions (shared) ---- //

export function roundTime(value: number) {
  return Math.round(Math.max(Number(value) || 0, 0) * 10) / 10
}

export function formatEditorTime(value: number) {
  const rounded = roundTime(value)
  const base = formatDuration(rounded)
  const tenth = Math.round((rounded % 1) * 10)
  return `${base}.${tenth}`
}

export function parseEditorTime(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const colonMatch = trimmed.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d))?$/)
  if (colonMatch) {
    const minutes = Number(colonMatch[1])
    const seconds = Number(colonMatch[2])
    const tenths = colonMatch[3] ? Number(colonMatch[3]) : 0
    if (seconds >= 60) return null
    return minutes * 60 + seconds + tenths / 10
  }

  const dotMatch = trimmed.match(/^(\d+)\.(\d)$/)
  if (dotMatch) {
    const digits = dotMatch[1]
    const tenths = Number(dotMatch[2])
    if (digits.length >= 3) {
      const minutes = Number(digits.slice(0, -2))
      const seconds = Number(digits.slice(-2))
      if (seconds >= 60) return null
      return minutes * 60 + seconds + tenths / 10
    }
    const seconds = Number(digits)
    if (seconds >= 60) return null
    return seconds + tenths / 10
  }

  const pureDigitsMatch = trimmed.match(/^\d+$/)
  if (pureDigitsMatch) {
    const digits = trimmed
    let minutes = 0
    let seconds = 0
    let tenths = 0

    if (digits.length === 1) {
      tenths = Number(digits)
    } else if (digits.length === 2) {
      seconds = Number(digits.slice(0, 1))
      tenths = Number(digits.slice(1))
    } else if (digits.length === 3) {
      seconds = Number(digits.slice(0, 2))
      tenths = Number(digits.slice(2))
    } else {
      tenths = Number(digits.slice(-1))
      seconds = Number(digits.slice(-3, -1))
      minutes = Number(digits.slice(0, -3))
    }

    if (seconds >= 60) return null
    return minutes * 60 + seconds + tenths / 10
  }

  return null
}

// ---- Icons ---- //

export function PlayIcon() {
  return (
    <svg className="manual-lyrics-editor__play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" />
    </svg>
  )
}

export function PauseIcon() {
  return (
    <svg className="manual-lyrics-editor__play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" fill="currentColor" />
    </svg>
  )
}

export function XIcon() {
  return (
    <svg className="manual-lyrics-editor__close-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6 6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
