import { formatEditorTime } from './LyricsEditorUtils'

interface DraftLyricLine {
  text: string
  startTime: number | null
}

interface LyricsLineRowProps {
  line: DraftLyricLine
  index: number
  isSelected: boolean
  editMode: boolean
  onSelect: (index: number) => void
  onTickTime: (index: number, delta: number) => void
  onUpdateText: (index: number, text: string) => void
}

export function LyricsLineRow({ line, index, isSelected, editMode, onSelect, onTickTime, onUpdateText }: LyricsLineRowProps) {
  return (
    <div
      className={`manual-lyrics-editor__row${isSelected ? ' is-selected' : ''}${line.startTime !== null ? ' is-complete' : ''}`}
      onClick={() => onSelect(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(index) }}
    >
      <span className="manual-lyrics-editor__row-index">{index + 1}</span>
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
        <span className="manual-lyrics-editor__row-time" title="Thời gian dòng này">
          {line.startTime === null ? '--:--.-' : formatEditorTime(line.startTime)}
        </span>
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
