import { create } from 'zustand'
import type { Track } from '../services/musicApi'
import { normalizeApiBase } from '../services/musicApi'

type RepeatMode = 'off' | 'all' | 'one'

interface PlayerState {
  queue: Track[]
  currentIndex: number
  isPlaying: boolean
  playbackRate: number
  progress: number
  duration: number
  volume: number
  shuffle: boolean
  repeat: RepeatMode
  favorites: Track[]
  history: Track[]
  lastQuery: string
  lastResults: Track[]
  recentSearches: string[]
  pendingSeek: number | null
  apiBase: string
  lyricOffsets: Record<string, number>
  localDownloadPath: string
}

export interface PlayerStore extends PlayerState {
  actions: {
    setQueue: (queue: Track[], startIndex?: number, autoplay?: boolean) => void
    playTrack: (track: Track, sourceQueue?: Track[]) => void
    play: () => void
    pause: () => void
    toggle: () => void
    setPlaybackRate: (value: number) => void
    next: () => void
    previous: () => void
    handleTrackEnd: () => void
    seek: (value: number) => void
    acknowledgeSeek: () => void
    syncProgress: (current: number, duration: number) => void
    setPlaying: (value: boolean) => void
    setVolume: (value: number) => void
    toggleShuffle: () => void
    cycleRepeat: () => void
    toggleFavorite: (track: Track) => void
    setLastSearch: (query: string, items: Track[]) => void
    clearHistory: () => void
    setApiBase: (base: string) => void
    setLyricOffset: (trackId: string, value: number) => void
    nudgeLyricOffset: (trackId: string, delta: number) => void
    resetLyricOffset: (trackId: string) => void
    updateTrack: (trackId: string, partial: Partial<Track>) => void
    setLocalDownloadPath: (path: string) => void
  }
}

const STORAGE_KEY = 'pulseframe-player-state'
const MAX_HISTORY = 24
const MAX_LYRIC_OFFSET = 12
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function normalizeTrack(track: Track | null | undefined) {
  if (!track) return null
  const id = String(track.id || '').trim()
  if (!id) return null

  return {
    id,
    title: String(track.title || 'Không rõ tiêu đề'),
    artist: String(track.artist || 'Không rõ nghệ sĩ'),
    album: String(track.album || 'YouTube Music'),
    duration: Number(track.duration || 0),
    thumbnail: typeof track.thumbnail === 'string' ? track.thumbnail : '',
    sourceThumbnail:
      typeof track.sourceThumbnail === 'string'
        ? track.sourceThumbnail
        : typeof track.thumbnail === 'string'
          ? track.thumbnail
          : '',
  }
}

function normalizeTrackList(list: Track[] | unknown) {
  if (!Array.isArray(list)) return []

  const seen = new Set<string>()
  const output: Track[] = []

  for (const item of list) {
    const normalized = normalizeTrack(item as Track)
    if (!normalized || seen.has(normalized.id)) continue
    seen.add(normalized.id)
    output.push(normalized)
  }

  return output
}

function pushToHistory(history: Track[], track: Track | null) {
  const normalized = normalizeTrack(track)
  if (!normalized) return history

  return [normalized, ...history.filter((item) => item.id !== normalized.id)].slice(0, MAX_HISTORY)
}

function normalizeLyricOffset(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.round(clamp(numeric, -MAX_LYRIC_OFFSET, MAX_LYRIC_OFFSET) * 10) / 10
}

function normalizeLyricOffsets(value: unknown) {
  if (!value || typeof value !== 'object') return {}

  const output: Record<string, number> = {}

  for (const [key, rawValue] of Object.entries(value)) {
    const trackId = String(key || '').trim()
    if (!trackId) continue

    const offset = normalizeLyricOffset(rawValue)
    if (offset !== 0) {
      output[trackId] = offset
    }
  }

  return output
}

function normalizePlaybackRate(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1

  const nearest = PLAYBACK_RATES.reduce((best, rate) =>
    Math.abs(rate - numeric) < Math.abs(best - numeric) ? rate : best
  )

  return nearest || 1
}

function updateLyricOffsetMap(previous: Record<string, number>, trackId: string, value: number) {
  const id = String(trackId || '').trim()
  if (!id) return previous

  const normalized = normalizeLyricOffset(value)
  if (normalized === 0) {
    if (!(id in previous)) return previous
    const next = { ...previous }
    delete next[id]
    return next
  }

  return {
    ...previous,
    [id]: normalized,
  }
}

function getDefaultState(): PlayerState {
  return {
    queue: [],
    currentIndex: 0,
    isPlaying: false,
    playbackRate: 1,
    progress: 0,
    duration: 0,
    volume: 0.72,
    shuffle: false,
    repeat: 'off',
    favorites: [],
    history: [],
    lastQuery: '',
    lastResults: [],
    recentSearches: [],
    pendingSeek: null,
    apiBase: '',
    lyricOffsets: {},
    localDownloadPath: '',
  }
}

function loadPersistedState(): PlayerState {
  if (typeof window === 'undefined') {
    return getDefaultState()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) throw new Error('empty')
    const parsed = JSON.parse(raw)

    const nextState: PlayerState = {
      queue: normalizeTrackList(parsed?.queue),
      currentIndex: Number.isInteger(parsed?.currentIndex) ? parsed.currentIndex : 0,
      isPlaying: false,
      playbackRate: normalizePlaybackRate(parsed?.playbackRate),
      progress: 0,
      duration: 0,
      volume: Number.isFinite(parsed?.volume) ? parsed.volume : 0.72,
      shuffle: Boolean(parsed?.shuffle),
      repeat: ['off', 'all', 'one'].includes(parsed?.repeat) ? parsed.repeat : 'off',
      favorites: normalizeTrackList(parsed?.favorites),
      history: normalizeTrackList(parsed?.history).slice(0, MAX_HISTORY),
      lastQuery: typeof parsed?.lastQuery === 'string' ? parsed.lastQuery : '',
      lastResults: normalizeTrackList(parsed?.lastResults),
      recentSearches: Array.isArray(parsed?.recentSearches)
        ? parsed.recentSearches.filter((s: unknown) => typeof s === 'string' && s.trim()).slice(0, 10)
        : [],
      pendingSeek: null,
      apiBase: normalizeApiBase(parsed?.apiBase),
      lyricOffsets: normalizeLyricOffsets(parsed?.lyricOffsets),
      localDownloadPath: typeof parsed?.localDownloadPath === 'string' ? parsed.localDownloadPath : '',
    }

    if (nextState.currentIndex >= nextState.queue.length) {
      nextState.currentIndex = 0
    }

    return nextState
  } catch {
    return getDefaultState()
  }
}

export function getCurrentTrack(state: PlayerState) {
  return state.queue[state.currentIndex] ?? null
}

export function getEffectiveDuration(state: PlayerState) {
  return state.duration || getCurrentTrack(state)?.duration || 0
}

function getNextIndex(state: PlayerState) {
  const total = state.queue.length
  if (!total) return null

  if (state.shuffle && total > 1) {
    let next = state.currentIndex
    while (next === state.currentIndex) {
      next = Math.floor(Math.random() * total)
    }
    return next
  }

  if (state.currentIndex < total - 1) return state.currentIndex + 1
  return state.repeat === 'all' ? 0 : null
}

function getPreviousIndex(state: PlayerState) {
  const total = state.queue.length
  if (!total) return null

  if (state.shuffle && total > 1) {
    let previous = state.currentIndex
    while (previous === state.currentIndex) {
      previous = Math.floor(Math.random() * total)
    }
    return previous
  }

  if (state.currentIndex > 0) return state.currentIndex - 1
  return state.repeat === 'all' ? total - 1 : null
}

function selectIndex(state: PlayerState, index: number, autoplay = state.isPlaying): PlayerState {
  if (!state.queue.length) {
    return {
      ...state,
      currentIndex: 0,
      isPlaying: false,
      progress: 0,
      duration: 0,
      pendingSeek: null,
    }
  }

  const nextIndex = clamp(index, 0, Math.max(0, state.queue.length - 1))
  const track = state.queue[nextIndex]

  return {
    ...state,
    currentIndex: nextIndex,
    isPlaying: autoplay,
    progress: 0,
    duration: 0,
    pendingSeek: null,
    history: pushToHistory(state.history, track),
  }
}

export const usePlayer = create<PlayerStore>()((set) => ({
  ...loadPersistedState(),
  actions: {
    setQueue(queue, startIndex = 0, autoplay = true) {
      set((previous) => {
        const normalizedQueue = normalizeTrackList(queue)

        if (!normalizedQueue.length) {
          return {
            ...previous,
            queue: [],
            currentIndex: 0,
            isPlaying: false,
            progress: 0,
            duration: 0,
            pendingSeek: null,
          }
        }

        return selectIndex(
          {
            ...previous,
            queue: normalizedQueue,
          },
          startIndex,
          autoplay
        )
      })
    },
    playTrack(track, sourceQueue) {
      const normalized = normalizeTrack(track)
      if (!normalized) return

      set((previous) => {
        if (sourceQueue?.length) {
          const queue = normalizeTrackList(sourceQueue)
          const index = queue.findIndex((item) => item.id === normalized.id)

          return selectIndex(
            {
              ...previous,
              queue,
            },
            index >= 0 ? index : 0,
            true
          )
        }

        const existingIndex = previous.queue.findIndex((item) => item.id === normalized.id)

        if (existingIndex >= 0) {
          return selectIndex(previous, existingIndex, true)
        }

        const queue = [...previous.queue, normalized]
        return selectIndex(
          {
            ...previous,
            queue,
          },
          queue.length - 1,
          true
        )
      })
    },
    play() {
      set((previous) => {
        if (!getCurrentTrack(previous)) return previous
        return { isPlaying: true }
      })
    },
    pause() {
      set({ isPlaying: false })
    },
    toggle() {
      set((previous) => {
        if (!getCurrentTrack(previous)) return previous
        return { isPlaying: !previous.isPlaying }
      })
    },
    setPlaybackRate(value) {
      set({
        playbackRate: normalizePlaybackRate(value),
      })
    },
    next() {
      set((previous) => {
        const nextIndex = getNextIndex(previous)
        if (nextIndex === null) {
          return {
            isPlaying: false,
            progress: getEffectiveDuration(previous),
          }
        }

        return selectIndex(previous, nextIndex, true)
      })
    },
    previous() {
      set((previous) => {
        if (previous.progress > 4) {
          return {
            progress: 0,
            pendingSeek: 0,
          }
        }

        const previousIndex = getPreviousIndex(previous)
        if (previousIndex === null) {
          return {
            progress: 0,
            pendingSeek: 0,
          }
        }

        return selectIndex(previous, previousIndex, true)
      })
    },
    handleTrackEnd() {
      set((previous) => {
        if (previous.repeat === 'one') {
          return {
            isPlaying: true,
            progress: 0,
            pendingSeek: 0,
          }
        }

        const nextIndex = getNextIndex(previous)
        if (nextIndex === null) {
          return {
            isPlaying: false,
            progress: getEffectiveDuration(previous),
          }
        }

        return selectIndex(previous, nextIndex, true)
      })
    },
    seek(value) {
      set((previous) => {
        const duration = getEffectiveDuration(previous)
        const nextProgress = clamp(Number(value) || 0, 0, duration)

        return {
          progress: nextProgress,
          pendingSeek: nextProgress,
        }
      })
    },
    acknowledgeSeek() {
      set({ pendingSeek: null })
    },
    syncProgress(current, duration) {
      set((previous) => ({
        progress: clamp(Number(current) || 0, 0, Number(duration) || getEffectiveDuration(previous)),
        duration: Number.isFinite(duration) && duration > 0 ? duration : previous.duration,
      }))
    },
    setPlaying(value) {
      set({ isPlaying: Boolean(value) })
    },
    setVolume(value) {
      set({
        volume: clamp(Number(value) || 0, 0, 1),
      })
    },
    toggleShuffle() {
      set((previous) => ({ shuffle: !previous.shuffle }))
    },
    cycleRepeat() {
      set((previous) => ({
        repeat: previous.repeat === 'off' ? 'all' : previous.repeat === 'all' ? 'one' : 'off',
      }))
    },
    toggleFavorite(track) {
      const normalized = normalizeTrack(track)
      if (!normalized) return

      set((previous) => {
        const exists = previous.favorites.some((item) => item.id === normalized.id)

        return {
          favorites: exists
            ? previous.favorites.filter((item) => item.id !== normalized.id)
            : [normalized, ...previous.favorites],
        }
      })
    },
    setLastSearch(query, items) {
      set((previous) => {
        const trimmed = String(query || '').trim()
        const updatedRecent = trimmed
          ? [trimmed, ...previous.recentSearches.filter((s) => s !== trimmed)].slice(0, 10)
          : previous.recentSearches
        return {
          lastQuery: trimmed,
          lastResults: normalizeTrackList(items).slice(0, 24),
          recentSearches: updatedRecent,
        }
      })
    },
    clearHistory() {
      set({ history: [] })
    },
    setApiBase(base) {
      set({
        apiBase: normalizeApiBase(base),
      })
    },
    setLyricOffset(trackId, value) {
      set((previous) => ({
        lyricOffsets: updateLyricOffsetMap(previous.lyricOffsets, trackId, value),
      }))
    },
    nudgeLyricOffset(trackId, delta) {
      set((previous) => {
        const id = String(trackId || '').trim()
        if (!id) return previous

        return {
          lyricOffsets: updateLyricOffsetMap(previous.lyricOffsets, id, (previous.lyricOffsets[id] || 0) + Number(delta || 0)),
        }
      })
    },
    resetLyricOffset(trackId) {
      set((previous) => ({
        lyricOffsets: updateLyricOffsetMap(previous.lyricOffsets, trackId, 0),
      }))
    },
    updateTrack(trackId: string, partial: Partial<Track>) {
      set((previous) => {
        const id = String(trackId || '').trim()
        if (!id) return previous

        const updateTrackItem = (item: Track) => (item.id === id ? { ...item, ...partial } : item)

        return {
          queue: previous.queue.map(updateTrackItem),
          history: previous.history.map(updateTrackItem),
          favorites: previous.favorites.map(updateTrackItem),
          lastResults: previous.lastResults.map(updateTrackItem),
        }
      })
    },
    setLocalDownloadPath(path: string) {
      set({ localDownloadPath: String(path || '').trim() })
    },
  }
}))

if (typeof window !== 'undefined') {
  usePlayer.subscribe((state) => {
    const payload = {
      queue: state.queue,
      currentIndex: state.currentIndex,
      volume: state.volume,
      playbackRate: state.playbackRate,
      shuffle: state.shuffle,
      repeat: state.repeat,
      favorites: state.favorites,
      history: state.history,
      lastQuery: state.lastQuery,
      lastResults: state.lastResults,
      recentSearches: state.recentSearches,
      apiBase: state.apiBase,
      lyricOffsets: state.lyricOffsets,
      localDownloadPath: state.localDownloadPath,
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  })
}

// Dummy provider to not break main.tsx immediately
export function PlayerProvider({ children }: { children: import('react').ReactNode }) {
  return <>{children}</>
}
