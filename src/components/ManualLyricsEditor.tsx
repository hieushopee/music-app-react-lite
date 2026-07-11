import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '../lib/format'
import type { SyncedLyricLine, Track } from '../services/musicApi'

interface DraftLyricLine {
  text: string
  startTime: number | null
}

interface ManualLyricsEditorProps {
  open: boolean
  track: Track | null
  initialLines: DraftLyricLine[]
  currentTime: number
  duration: number
  isPlaying: boolean
  playbackRate: number
  hasManualSync: boolean
  hasManualThumbnail: boolean
  onClose: () => void
  onTogglePlayback: () => void
  onSeek: (value: number) => void
  onSetPlaybackRate: (value: number) => void
  onSave: (payload: { lyrics: string[]; lines: SyncedLyricLine[]; thumbnail?: string }) => Promise<void>
  onDelete: () => Promise<void>
  onResetCover: () => Promise<void>
  onResetLyrics: () => Promise<void>
}

export function ManualLyricsEditor({
  open,
  track,
  initialLines,
  currentTime,
  duration,
  isPlaying,
  playbackRate,
  hasManualSync,
  hasManualThumbnail,
  onClose,
  onTogglePlayback,
  onSeek,
  onSetPlaybackRate,
  onSave,
  onDelete,
  onResetCover,
  onResetLyrics,
}: ManualLyricsEditorProps) {
  const [draftLines, setDraftLines] = useState<DraftLyricLine[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkValue, setBulkValue] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [customThumbnail, setCustomThumbnail] = useState('')
  const [resettingCover, setResettingCover] = useState(false)
  const [resettingLyrics, setResettingLyrics] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return

    setDraftLines(initialLines.map((line) => ({ text: line.text, startTime: line.startTime })))
    setSelectedIndex(Math.max(0, initialLines.findIndex((line) => line.startTime === null)))
    setBulkValue(initialLines.map((line) => line.text).join('\n'))
    setBulkOpen(false)
    setEditMode(false)
    setError('')
    setSaving(false)
    setDeleting(false)
    setResettingCover(false)
    setResettingLyrics(false)
    setCustomThumbnail('')
  }, [open, initialLines, track?.id])

  const selectedLine = draftLines[selectedIndex] || null
  const missingCount = useMemo(() => draftLines.filter((line) => line.startTime === null).length, [draftLines])
  const hasLyrics = draftLines.length > 0
  const allStamped = hasLyrics && draftLines.every((line) => line.startTime !== null)
  const saveLabel = allStamped ? 'Lưu lời chạy' : 'Lưu lyrics'

  if (!open || !track) return null

  function buildSavePayload(thumbnailOverride?: string) {
    const lyrics = draftLines.map((line) => String(line.text || '').trim()).filter(Boolean)

    if (!lyrics.length && !thumbnailOverride) {
      throw new Error('Không có dòng lyric nào để lưu.')
    }

    const lines = allStamped
      ? draftLines.map((line) => ({
          text: String(line.text || '').trim(),
          startTime: roundTime(line.startTime || 0),
        }))
      : []

    if (lines.length) {
      for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].startTime < lines[index - 1].startTime) {
          throw new Error('Mốc thời gian phải tăng dần từ trên xuống dưới.')
        }
      }
    }

    return {
      lyrics,
      lines,
      thumbnail: thumbnailOverride,
    }
  }

  function updateSelectedLine(nextTime: number | null) {
    setDraftLines((previous) =>
      previous.map((line, index) => (index === selectedIndex ? { ...line, startTime: nextTime === null ? null : roundTime(nextTime) } : line))
    )
  }

  function handleStamp() {
    if (!selectedLine) return

    updateSelectedLine(currentTime)
    setSelectedIndex((previous) => {
      const nextIncomplete = draftLines.findIndex((line, index) => index > previous && line.startTime === null)
      return nextIncomplete >= 0 ? nextIncomplete : previous
    })
    setError('')
  }

  function handleNudge(delta: number) {
    if (!selectedLine) return
    const base = selectedLine.startTime ?? currentTime
    updateSelectedLine(Math.max(base + delta, 0))
    setError('')
  }

  function handleClear() {
    updateSelectedLine(null)
    setError('')
  }

  function handleTickTime(index: number, delta: number) {
    setDraftLines((previous) =>
      previous.map((line, lineIndex) => {
        if (lineIndex !== index) return line
        const base = line.startTime ?? 0
        return { ...line, startTime: roundTime(Math.max(base + delta, 0)) }
      })
    )
    setError('')
  }

  function updateLineText(index: number, text: string) {
    setDraftLines((previous) => previous.map((line, lineIndex) => (lineIndex === index ? { ...line, text } : line)))
  }

  function handleOpenBulkLyrics() {
    setBulkValue(draftLines.map((line) => line.text).join('\n'))
    setBulkOpen(true)
    setEditMode(false)
    setError('')
  }

  function handleApplyBulkLyrics() {
    const nextLines = bulkValue
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (!nextLines.length) {
      setError('Bạn cần nhập ít nhất một dòng lyrics.')
      return
    }

    setDraftLines(nextLines.map((text) => ({ text, startTime: null })))
    setSelectedIndex(0)
    setBulkOpen(false)
    setEditMode(false)
    setError('')
  }

  function handleSeekSelected() {
    if (selectedLine?.startTime === null || selectedLine?.startTime === undefined) return
    onSeek(selectedLine.startTime)
  }

  function handleCyclePlaybackRate() {
    const rates = [0.5, 0.75, 1, 2]
    const rate = Number(playbackRate) || 1
    const currentIndex = rates.findIndex((value) => value === rate)
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % rates.length : 2
    onSetPlaybackRate(rates[nextIndex])
  }
  
  function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setError('Vui lòng chọn tệp hình ảnh.')
      event.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = async (e) => {
      const img = new Image()
      img.onload = async () => {
        const canvas = document.createElement('canvas')
        const maxDim = 480
        let width = img.width
        let height = img.height

        if (width > height) {
          if (width > maxDim) {
            height *= maxDim / width
            width = maxDim
          }
        } else {
          if (height > maxDim) {
            width *= maxDim / height
            height = maxDim
          }
        }

        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, width, height)
        const compressed = canvas.toDataURL('image/jpeg', 0.8)

        setSaving(true)
        setError('')

        try {
          const payload = buildSavePayload(compressed)
          await onSave(payload)
          setCustomThumbnail(compressed)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : 'Không lưu được ảnh bìa.')
        } finally {
          setSaving(false)
          event.target.value = ''
        }
      }
      img.src = e.target?.result as string
    }
    reader.readAsDataURL(file)
  }

  async function handleSave() {
    setSaving(true)
    setError('')

    try {
      await onSave(buildSavePayload(customThumbnail || undefined))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không lưu được lyrics.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!hasManualSync) return
    if (!window.confirm(`Xóa lời chạy đã lưu cho "${track?.title || 'bài hát này'}"?`)) return

    setDeleting(true)
    setError('')

    try {
      await onDelete()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không xóa được lời chạy.')
    } finally {
      setDeleting(false)
    }
  }

  async function handleResetCover() {
    if (!hasManualThumbnail) return

    setResettingCover(true)
    setError('')

    try {
      await onResetCover()
      setCustomThumbnail('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không reset được ảnh bìa.')
    } finally {
      setResettingCover(false)
    }
  }

  async function handleResetLyrics() {
    if (!hasManualSync) return

    setResettingLyrics(true)
    setError('')

    try {
      await onResetLyrics()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không reset được lời bài hát.')
    } finally {
      setResettingLyrics(false)
    }
  }

  return (
    <div className="manual-lyrics-editor" role="dialog" aria-modal="true" aria-label="Chỉnh lời theo thời gian">
      <button type="button" className="manual-lyrics-editor__scrim" aria-label="Đóng trình chỉnh lời" onClick={onClose} />

      <section className="manual-lyrics-editor__panel">
        <div className="manual-lyrics-editor__header">
          <div className="manual-lyrics-editor__copy">
            <span>Chỉnh lời theo thời gian</span>
            <div className="manual-lyrics-editor__title-line">
              <h3>{track.title}</h3>
              <p>{track.artist}</p>
            </div>
          </div>

          <button type="button" className="manual-lyrics-editor__close" onClick={onClose} aria-label="Đóng">
            <XIcon />
          </button>
        </div>

        <div className="manual-lyrics-editor__body">
          <div className="manual-lyrics-editor__toolbar">
            <button
              type="button"
              className={`ghost-pill${bulkOpen ? ' is-active' : ''}`}
              onClick={handleOpenBulkLyrics}
            >
              Thêm lyrics
            </button>
            <button
              type="button"
              className={`ghost-pill${editMode ? ' is-active' : ''}`}
              onClick={() => {
                setEditMode((previous) => !previous)
                setBulkOpen(false)
              }}
              disabled={!hasLyrics}
            >
              Sửa lyrics
            </button>
            <button type="button" className="ghost-pill" onClick={handleStamp}>
              Gán mốc dòng này
            </button>
            <div className="manual-lyrics-editor__toolbar-pair">
              <button type="button" className="ghost-pill" onClick={() => handleNudge(-0.5)}>
                -0.5 giây
              </button>
              <button type="button" className="ghost-pill" onClick={() => handleNudge(0.5)}>
                +0.5 giây
              </button>
            </div>
            <div className="manual-lyrics-editor__toolbar-pair">
              <button type="button" className="ghost-pill" onClick={handleSeekSelected} disabled={selectedLine?.startTime === null}>
                Tới mốc
              </button>
              <button type="button" className="ghost-pill" onClick={handleClear}>
                Xóa mốc
              </button>
            </div>
            <button type="button" className="ghost-pill" onClick={() => fileInputRef.current?.click()}>
              {saving ? 'Đang lưu ảnh...' : 'Đổi ảnh bìa'}
            </button>
            <button
              type="button"
              className="ghost-pill"
              onClick={handleResetCover}
              disabled={!hasManualThumbnail || resettingCover || saving}
            >
              Reset ảnh bìa
            </button>
            <button
              type="button"
              className="ghost-pill"
              onClick={handleResetLyrics}
              disabled={!hasManualSync || resettingLyrics || saving}
            >
              Reset lời bài hát
            </button>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="image/*"
              onChange={handleFileSelect}
            />

            <div className="manual-lyrics-editor__footer manual-lyrics-editor__footer--side">
              <div className="manual-lyrics-editor__footer-meta">
                {hasManualSync ? <span>Bài này đang dùng lời tự canh. Lưu lại sẽ ghi đè mốc cũ.</span> : null}
                {!hasManualSync && allStamped ? <span>Sau khi lưu, player sẽ dùng bộ mốc này.</span> : null}
              </div>

              <div className="manual-lyrics-editor__footer-actions">
                {hasManualSync ? (
                  <button type="button" className="ghost-pill" onClick={handleDelete} disabled={deleting || saving}>
                    {deleting ? 'Đang xóa...' : 'Xóa lời tự canh'}
                  </button>
                ) : null}
                <div className="manual-lyrics-editor__footer-action-pair">
                  <button type="button" className="ghost-pill" onClick={onClose} disabled={saving || deleting}>
                    Hủy
                  </button>
                  <button type="button" className="action-pill" onClick={handleSave} disabled={saving || deleting}>
                    {saving ? 'Đang lưu...' : saveLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="manual-lyrics-editor__main">
            {bulkOpen ? (
              <div className="manual-lyrics-editor__bulk">
                <label className="manual-lyrics-editor__bulk-label" htmlFor="manual-lyrics-bulk">
                  Dán toàn bộ lyrics, mỗi dòng là một câu
                </label>
                <textarea
                  id="manual-lyrics-bulk"
                  className="manual-lyrics-editor__bulk-input"
                  value={bulkValue}
                  onChange={(event) => setBulkValue(event.target.value)}
                  placeholder={'Ví dụ:\nCâu 1\nCâu 2\nCâu 3'}
                />
                <div className="manual-lyrics-editor__bulk-actions">
                  <button type="button" className="ghost-pill" onClick={() => setBulkOpen(false)}>
                    Hủy thêm
                  </button>
                  <button type="button" className="action-pill" onClick={handleApplyBulkLyrics}>
                    Áp dụng lyrics
                  </button>
                </div>
              </div>
            ) : null}

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

              <button type="button" className="manual-lyrics-editor__speed-button is-active" onClick={handleCyclePlaybackRate}>
                {playbackRate}x
              </button>
            </div>

            <div className="manual-lyrics-editor__status">
              <span>Còn {missingCount} dòng chưa gán</span>
            </div>

            {error ? <p className="feedback error">{error}</p> : null}

            <div className="manual-lyrics-editor__list">
              {draftLines.length ? (
                draftLines.map((line, index) => (
                  <div
                    key={index}
                    className={`manual-lyrics-editor__row${index === selectedIndex ? ' is-selected' : ''}${line.startTime !== null ? ' is-complete' : ''}`}
                    onClick={() => setSelectedIndex(index)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelectedIndex(index) }}
                  >
                    <span className="manual-lyrics-editor__row-index">{index + 1}</span>
                    {editMode ? (
                      <input
                        className="manual-lyrics-editor__row-input"
                        value={line.text}
                        onChange={(event) => updateLineText(index, event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <span className="manual-lyrics-editor__row-text">{line.text}</span>
                    )}
                    <span className="manual-lyrics-editor__row-time-group" onClick={(e) => e.stopPropagation()}>
                      <span
                        className="manual-lyrics-editor__row-time"
                        title="Thời gian dòng này"
                      >
                        {line.startTime === null ? '--:--.-' : formatEditorTime(line.startTime)}
                      </span>
                      <span className="manual-lyrics-editor__row-tick-stack">
                        <button
                          type="button"
                          className="manual-lyrics-editor__row-tick"
                          title="Tăng 1 tích tắc (+0.1s)"
                          onClick={() => handleTickTime(index, 0.1)}
                          tabIndex={-1}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="manual-lyrics-editor__row-tick"
                          title="Giảm 1 tích tắc (−0.1s)"
                          onClick={() => handleTickTime(index, -0.1)}
                          tabIndex={-1}
                        >
                          ▼
                        </button>
                      </span>
                    </span>
                  </div>
                ))
              ) : (
                <div className="manual-lyrics-editor__empty">Chưa có lyrics cho bài này. Bấm `Thêm lyrics` để dán toàn bộ bài.</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function roundTime(value: number) {
  return Math.round(Math.max(Number(value) || 0, 0) * 10) / 10
}

function formatEditorTime(value: number) {
  const rounded = roundTime(value)
  const base = formatDuration(rounded)
  const tenth = Math.round((rounded % 1) * 10)
  return `${base}.${tenth}`
}

function parseEditorTime(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Try MM:SS.T or MM:SS
  const colonMatch = trimmed.match(/^(\d{1,3}):(\d{1,2})(?:\.(\d))?$/)
  if (colonMatch) {
    const minutes = Number(colonMatch[1])
    const seconds = Number(colonMatch[2])
    const tenths = colonMatch[3] ? Number(colonMatch[3]) : 0
    if (seconds >= 60) return null
    return minutes * 60 + seconds + tenths / 10
  }

  // Try explicit dot format (e.g. 12.3 -> 12s 3t, 112.3 -> 1m 12s 3t)
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

  // Try pure digits sequence (right-to-left shift: T -> SS -> M)
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

function PlayIcon() {
  return (
    <svg className="manual-lyrics-editor__play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg className="manual-lyrics-editor__play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h4v14H7V5Zm6 0h4v14h-4V5Z" fill="currentColor" />
    </svg>
  )
}

function XIcon() {
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
