import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { LyricsView } from '../components/LyricsView'
import { ManualLyricsEditor } from '../components/ManualLyricsEditor'
import { getCoverStyle } from '../lib/cover'
import { buildLyricTimeline, findActiveLyricIndex } from '../lib/lyrics'
import {
  deleteManualLyrics,
  fetchTrackContext,
  resetManualCover,
  resetManualLyrics,
  saveManualLyrics,
  type SyncedLyricLine,
} from '../services/musicApi'
import { usePlayer, getCurrentTrack, getEffectiveDuration } from '../store/player'

export function PlayerPage() {
  const state = usePlayer()
  const { actions } = state
  const currentTrack = getCurrentTrack(state)
  const effectiveDuration = getEffectiveDuration(state)
  const [lyrics, setLyrics] = useState<string[]>([])
  const [syncedLyrics, setSyncedLyrics] = useState<SyncedLyricLine[]>([])
  const [hasManualSync, setHasManualSync] = useState(false)
  const [manualThumbnail, setManualThumbnail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [contextVersion, setContextVersion] = useState(0)

  useEffect(() => {
    if (!currentTrack) return
    const track = currentTrack

    let cancelled = false

    async function loadContext() {
      setLoading(true)
      setError('')

      try {
        const context = await fetchTrackContext(track, state.apiBase)
        if (cancelled) return
        setLyrics(context.lyrics)
        setSyncedLyrics(context.syncedLyrics)
        setHasManualSync(context.hasManualSync)
        setManualThumbnail(context.thumbnail || '')
        const nextThumbnail = context.thumbnail || track.sourceThumbnail || ''
        if (nextThumbnail !== track.thumbnail) {
          actions.updateTrack(track.id, { thumbnail: nextThumbnail })
        }
      } catch (reason) {
        if (cancelled) return
        setLyrics([])
        setSyncedLyrics([])
        setHasManualSync(false)
        setManualThumbnail('')
        setError(reason instanceof Error ? reason.message : 'Không thể tải lời nhạc.')
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadContext()

    return () => {
      cancelled = true
    }
  }, [currentTrack?.id, state.apiBase, contextVersion])

  useEffect(() => {
    document.body.classList.add('player-mode')

    return () => {
      document.body.classList.remove('player-mode')
    }
  }, [])

  useEffect(() => {
    setEditorOpen(false)
  }, [currentTrack?.id])

  useEffect(() => {
    const trackId = String(currentTrack?.id || '').trim()
    if (!trackId) return

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName || ''

      if (target?.isContentEditable || tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
        return
      }

      if (event.key === 'Enter' && tagName !== 'BUTTON') {
        event.preventDefault()
        actions.toggle()
        return
      }

      if (event.key === '[') {
        event.preventDefault()
        actions.nudgeLyricOffset(trackId, -0.5)
      }

      if (event.key === ']') {
        event.preventDefault()
        actions.nudgeLyricOffset(trackId, 0.5)
      }

      if (event.key === '\\') {
        event.preventDefault()
        actions.resetLyricOffset(trackId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [actions, currentTrack?.id])

  if (!currentTrack) {
    return (
      <main className="player-page player-page--empty">
        <div className="empty-player-card">
          <h2>Chưa có bài hát nào được chọn.</h2>
          <Link to="/" className="action-pill">
            Về trang chủ để chọn bài
          </Link>
        </div>
      </main>
    )
  }

  const lyricOffset = state.lyricOffsets[currentTrack.id] || 0
  const hasSyncedLyrics = syncedLyrics.length > 0
  const lines = buildLyricTimeline(syncedLyrics, lyrics, effectiveDuration || currentTrack.duration)
  const activeIndex = hasSyncedLyrics ? findActiveLyricIndex(lines, state.progress + lyricOffset) : -1
  const editorSeedLines = useMemo(
    () =>
      syncedLyrics.length
        ? syncedLyrics.map((line) => ({ text: line.text, startTime: line.startTime }))
        : lyrics.map((text) => ({ text, startTime: null })),
    [syncedLyrics, lyrics]
  )

  const showLyricsEditorControl = Boolean(currentTrack)

  async function handleSaveManual(payload: { lyrics: string[]; lines: SyncedLyricLine[]; thumbnail?: string }) {
    if (!currentTrack) return
    const nextThumbnail = payload.thumbnail === undefined ? manualThumbnail : payload.thumbnail
    await saveManualLyrics(currentTrack, payload.lyrics, payload.lines, state.apiBase, nextThumbnail)
    if (payload.thumbnail) {
      actions.updateTrack(currentTrack.id, { thumbnail: payload.thumbnail })
    }
    setContextVersion((previous) => previous + 1)
  }

  async function handleDeleteManual() {
    if (!currentTrack) return
    await deleteManualLyrics(currentTrack.id, state.apiBase)
    setContextVersion((previous) => previous + 1)
  }

  async function handleResetManualCover() {
    if (!currentTrack) return
    await resetManualCover(currentTrack.id, state.apiBase)
    setContextVersion((previous) => previous + 1)
  }

  async function handleResetManualLyrics() {
    if (!currentTrack) return
    await resetManualLyrics(currentTrack.id, state.apiBase)
    setContextVersion((previous) => previous + 1)
  }

  function handleSeekLyricLine(startTime: number) {
    const targetTime = Math.max(startTime - lyricOffset, 0)
    actions.seek(targetTime)
  }

  return (
    <main className="player-page">
      <div className="player-backdrop" style={getCoverStyle(currentTrack.thumbnail)} />

      <section className="player-stage">
        <div className="player-art-wrap">
          <div className="player-artwork" style={getCoverStyle(currentTrack.thumbnail)} />
        </div>

        <div className="player-lyrics-wrap">
          <LyricsView
            lines={lines}
            activeIndex={activeIndex}
            loading={loading}
            error={error}
            synced={hasSyncedLyrics}
            onSeekLine={(line) => handleSeekLyricLine(line.start)}
          />
        </div>
      </section>

      <div className="player-controls">
        <div className="player-controls__main">
          <button
            type="button"
            className={`control-button control-button--ghost${state.shuffle ? ' is-active' : ''}`}
            aria-label="Bật hoặc tắt phát ngẫu nhiên"
            onClick={actions.toggleShuffle}
          >
            <ShuffleIcon />
          </button>
          <button
            type="button"
            className="control-button control-button--ghost"
            aria-label="Bài trước"
            onClick={actions.previous}
          >
            <PreviousIcon />
          </button>
          <button
            type="button"
            className="control-button control-button--primary"
            aria-label={state.isPlaying ? 'Tạm dừng' : 'Phát'}
            onClick={actions.toggle}
          >
            {state.isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="control-button control-button--ghost"
            aria-label="Bài tiếp theo"
            onClick={actions.next}
          >
            <NextIcon />
          </button>
          <button
            type="button"
            className={`control-button control-button--ghost${state.repeat !== 'off' ? ' is-active' : ''}`}
            aria-label="Đổi chế độ lặp"
            onClick={actions.cycleRepeat}
          >
            {state.repeat === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
          </button>
        </div>

        {showLyricsEditorControl ? (
          <button
            type="button"
            className={`player-editor-trigger${editorOpen || hasManualSync ? ' is-active' : ''}`}
            aria-label={hasManualSync ? 'Sửa lời chạy thủ công' : 'Canh lời theo nhạc'}
            onClick={() => setEditorOpen(true)}
          >
            <SettingsIcon />
          </button>
        ) : null}
      </div>

      <ManualLyricsEditor
        open={editorOpen}
        track={currentTrack}
        initialLines={editorSeedLines}
        currentTime={state.progress}
        duration={effectiveDuration || currentTrack.duration}
        isPlaying={state.isPlaying}
        playbackRate={state.playbackRate}
        hasManualSync={hasManualSync}
        hasManualThumbnail={Boolean(manualThumbnail)}
        onClose={() => setEditorOpen(false)}
        onTogglePlayback={actions.toggle}
        onSeek={actions.seek}
        onSetPlaybackRate={actions.setPlaybackRate}
        onSave={handleSaveManual}
        onDelete={handleDeleteManual}
        onResetCover={handleResetManualCover}
        onResetLyrics={handleResetManualLyrics}
      />
    </main>
  )
}

function PlayIcon() {
  return (
    <svg className="control-button__icon control-button__icon--play" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg className="control-button__icon control-button__icon--play" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" fill="currentColor" />
    </svg>
  )
}

function PreviousIcon() {
  return (
    <svg className="control-button__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6h2v12H7V6Zm10 0v12l-7-6 7-6Z" fill="currentColor" />
    </svg>
  )
}

function NextIcon() {
  return (
    <svg className="control-button__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 6h2v12h-2V6ZM7 6l7 6-7 6V6Z" fill="currentColor" />
    </svg>
  )
}

function ShuffleIcon() {
  return (
    <svg className="control-button__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M16 4h4v4h-2V6.9l-3.3 3.3-1.4-1.4L16.6 5H16V4ZM4 7h3.8l4.2 4.2-1.4 1.4L7.2 9H4V7Zm9.3 4.8 1.4 1.4L11 17h-7v-2h6.2l3.1-3.2ZM18 15.1V14h2v6h-6v-2h2.6l-2.9-2.9 1.4-1.4 2.9 2.4Z"
        fill="currentColor"
      />
    </svg>
  )
}

function RepeatIcon() {
  return (
    <svg className="control-button__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 7h9.6l-1.8-1.8L16.2 4 20 7.8l-3.8 3.8-1.4-1.4L16.6 9H7c-1.1 0-2 .9-2 2v1H3v-1c0-2.2 1.8-4 4-4Zm10 10H7.4l1.8 1.8L7.8 20 4 16.2l3.8-3.8 1.4 1.4L7.4 15H17c1.1 0 2-.9 2-2v-1h2v1c0 2.2-1.8 4-4 4Z"
        fill="currentColor"
      />
    </svg>
  )
}

function RepeatOneIcon() {
  return (
    <svg className="control-button__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 7h9.6l-1.8-1.8L16.2 4 20 7.8l-3.8 3.8-1.4-1.4L16.6 9H7c-1.1 0-2 .9-2 2v1H3v-1c0-2.2 1.8-4 4-4Zm10 10H7.4l1.8 1.8L7.8 20 4 16.2l3.8-3.8 1.4 1.4L7.4 15H17c1.1 0 2-.9 2-2v-1h2v1c0 2.2-1.8 4-4 4Z"
        fill="currentColor"
      />
      <path d="M11.8 9.2h1.8v5.6h-1.8V11l-1 .6-.8-1.4 1.8-1Z" fill="currentColor" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="player-editor-trigger__icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.066 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.572c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  )
}
