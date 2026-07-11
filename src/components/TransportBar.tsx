import { PauseIcon, PlayIcon, formatEditorTime } from './LyricsEditorUtils'

interface TransportBarProps {
  currentTime: number
  duration: number
  isPlaying: boolean
  playbackRate: number
  onTogglePlayback: () => void
  onSeek: (value: number) => void
  onCyclePlaybackRate: () => void
}

export function TransportBar({
  currentTime,
  duration,
  isPlaying,
  playbackRate,
  onTogglePlayback,
  onSeek,
  onCyclePlaybackRate,
}: TransportBarProps) {
  return (
    <div className="manual-lyrics-editor__transport">
      <button
        type="button"
        className="manual-lyrics-editor__transport-toggle"
        onClick={onTogglePlayback}
        aria-label={isPlaying ? 'Tạm dừng' : 'Phát'}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>

      <span className="manual-lyrics-editor__transport-time">{formatEditorTime(currentTime)}</span>

      <input
        className="manual-lyrics-editor__transport-range"
        type="range"
        min={0}
        max={Math.max(duration, currentTime, 1)}
        step={0.1}
        value={Math.min(currentTime, Math.max(duration, currentTime, 1))}
        onChange={(event) => onSeek(Number(event.target.value))}
      />

      <span className="manual-lyrics-editor__transport-time">{formatEditorTime(duration)}</span>

      <button type="button" className="manual-lyrics-editor__speed-button is-active" onClick={onCyclePlaybackRate}>
        {playbackRate}x
      </button>
    </div>
  )
}
