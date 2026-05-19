import type { SyncedLyricLine } from '../services/musicApi'

export interface LyricLine {
  text: string
  start: number
  end: number
}

export function buildLyricTimeline(syncedLyrics: SyncedLyricLine[], lyrics: string[], duration: number) {
  if (syncedLyrics.length) {
    return syncedLyrics.map((line, index, list) => ({
      text: line.text,
      start: line.startTime,
      end: list[index + 1]?.startTime ?? Math.max(duration, line.startTime + 4),
    }))
  }

  return lyrics
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .map((text, index) => ({
      text,
      start: index,
      end: index + 1,
    }))
}

export function findActiveLyricIndex(lines: LyricLine[], progress: number) {
  if (!lines.length) return -1

  const time = Math.max(Number(progress) || 0, 0)
  const found = lines.findIndex((line, index) => {
    if (index === lines.length - 1) {
      return time >= line.start
    }

    return time >= line.start && time < line.end
  })

  return found >= 0 ? found : 0
}
