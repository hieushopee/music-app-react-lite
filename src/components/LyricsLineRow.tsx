import { useEffect, useState } from 'react'
import { formatEditorTime, parseEditorTime } from './LyricsEditorUtils'

interface DraftLyricLine {
  text: string
  startTime: number | null
}

interface LyricsLineRowProps {
  line: DraftLyricLine
  index: number
  isSelected: boolean
  isChecked: boolean
  editMode: boolean
  onSelect: (index: number) => void
  onToggleChecked: (index: number) => void
  onTickTime: (index: number, delta: number) => void
  onSetTime: (index: number, value: number | null) => void
  onUpdateText: (index: number, text: string) => void
}

export function LyricsLineRow({ line, index, isSelected, isChecked, editMode, onSelect, onToggleChecked, onTickTime, onSetTime, onUpdateText }: LyricsLineRowProps) {
  const [timeValue, setTimeValue] = useState(line.startTime === null ? '' : formatEditorTime(line.startTime))

  useEffect(() => {
    setTimeValue(line.startTime === null ? '' : formatEditorTime(line.startTime))
  }, [line.startTime])

  function applyTimeInput(value: string) {
    const trimmed = value.trim()
    if (!trimmed) {
      onSetTime(index, null)
      return
    }

    const parsed = parseEditorTime(trimmed)
    if (parsed !== null) {
      onSetTime(index, parsed)
      setTimeValue(formatEditorTime(parsed))
      return
    }

    setTimeValue(line.startTime === null ? '' : formatEditorTime(line.startTime))
  }

  return (
    <div
      className={`manual-lyrics-editor__row${isSelected ? ' is-selected' : ''}${line.startTime !== null ? ' is-complete' : ''}`}
      onClick={() => onSelect(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(index) }}
    >
      <span className="manual-lyrics-editor__row-index">{index + 1}</span>
      <input
        type="checkbox"
        className="manual-lyrics-editor__row-check"
        checked={isChecked}
        aria-label={`Chọn dòng ${index + 1}`}
        onChange={() => onToggleChecked(index)}
        onClick={(event) => event.stopPropagation()}
      />
      {editMode ? (
        <input
          className="manual-lyrics-editor__row-input"
          value={line.text}
          onChange={(event) => onUpdateText(index, event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span className="manual-lyrics-editor__row-text">{line.text}</span>
      )}
      <span className="manual-lyrics-editor__row-time-group" onClick={(e) => e.stopPropagation()}>
        <input
          className="manual-lyrics-editor__row-time-input"
          value={timeValue}
          placeholder="--:--.-"
          title="Nhập dạng 0:14.0 hoặc 00140"
          onChange={(event) => setTimeValue(event.target.value)}
          onBlur={(event) => applyTimeInput(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Enter') {
              applyTimeInput(event.currentTarget.value)
              event.currentTarget.blur()
            }
          }}
        />
        <span className="manual-lyrics-editor__row-tick-stack">
          <button
            type="button"
            className="manual-lyrics-editor__row-tick"
            title="Tăng 1 tích tắc (+0.1s)"
            onClick={() => onTickTime(index, 0.1)}
            tabIndex={-1}
          >
            ▲
          </button>
          <button
            type="button"
            className="manual-lyrics-editor__row-tick"
            title="Giảm 1 tích tắc (−0.1s)"
            onClick={() => onTickTime(index, -0.1)}
            tabIndex={-1}
          >
            ▼
          </button>
        </span>
      </span>
    </div>
  )
}
