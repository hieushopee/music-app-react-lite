import { useEffect, useState } from 'react'
import { getConfiguredApiBase, normalizeApiBase, testApiBase } from '../services/musicApi'
import { usePlayer, getCurrentTrack } from '../store/player'

export function SettingsPage() {
  const state = usePlayer()
  const { actions } = state
  const currentTrack = getCurrentTrack(state)
  const [draftBase, setDraftBase] = useState(state.apiBase)
  const [status, setStatus] = useState('')
  const [statusType, setStatusType] = useState<'idle' | 'ok' | 'error'>('idle')
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setDraftBase(state.apiBase)
  }, [state.apiBase])

  const configuredBase = getConfiguredApiBase()
  const activeBase = state.apiBase || configuredBase || '/api'
  const currentLyricOffset = currentTrack ? state.lyricOffsets[currentTrack.id] || 0 : 0

  async function handleTest() {
    setChecking(true)
    setStatus('')
    setStatusType('idle')

    try {
      const normalized = normalizeApiBase(draftBase)
      const result = await testApiBase(normalized)
      if (result?.configured === false) {
        throw new Error('YouTube API key chưa được cấu hình trên Worker.')
      }
      actions.setApiBase(normalized)
      setDraftBase(normalized)
      setStatusType('ok')
      setStatus(`Worker và kho dữ liệu đang hoạt động · đang dùng ${normalized || '/api'}`)
    } catch (error) {
      setStatusType('error')
      setStatus(
        error instanceof Error
          ? `Không thể kết nối Worker: ${error.message}`
          : 'Không kiểm tra được kết nối.'
      )
    } finally {
      setChecking(false)
    }
  }

  function handleSave() {
    const normalized = normalizeApiBase(draftBase)
    actions.setApiBase(normalized)
    setDraftBase(normalized)
    setStatusType('ok')
    setStatus(`Đã lưu địa chỉ API: ${normalized || '/api'}`)
  }

  function handleClear() {
    actions.setApiBase('')
    setDraftBase('')
    setStatusType('ok')
    setStatus('Đã xóa địa chỉ ghi đè. App sẽ dùng proxy mặc định hoặc biến môi trường.')
  }

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1>Cài đặt</h1>
      </header>

      <section className="settings-card settings-card--wide">
        <span>Kết nối ứng dụng</span>
        <h2>Cloudflare Worker</h2>
        <p>
          Ứng dụng đang dùng Worker cùng tên miền để tìm nhạc và lưu lyrics. Chỉ nhập URL bên dưới khi bạn cần dùng một API riêng.
        </p>

        <label className="settings-label" htmlFor="api-base">
          Địa chỉ API
        </label>
        <input
          id="api-base"
          className="settings-input"
          type="text"
          value={draftBase}
          onChange={(event) => setDraftBase(event.target.value)}
          placeholder="https://api.example.com"
        />

        <div className="settings-actions">
          <button type="button" className="action-pill" onClick={handleTest} disabled={checking}>
            {checking ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}
          </button>
          <button type="button" className="ghost-pill" onClick={handleSave}>
            Lưu URL
          </button>
          <button type="button" className="ghost-pill" onClick={handleClear}>
            Khôi phục mặc định
          </button>
        </div>

        {status ? <p className={`feedback ${statusType === 'error' ? 'error' : 'ok'}`}>{status}</p> : null}
      </section>

      <section className="settings-grid">
        <article className="settings-card">
          <span>Trạng thái</span>
          <h3>Cấu hình hiện tại</h3>
          <p>
            <strong>Biến môi trường:</strong> {configuredBase || '(không có)'}
          </p>
          <p>
            <strong>Ghi đè API:</strong> {state.apiBase || '(không có)'}
          </p>
          <p>
            <strong>Đang dùng:</strong> {activeBase}
          </p>
        </article>

        <article className="settings-card">
          <span>Triển khai</span>
          <h3>Hạ tầng hiện tại</h3>
          <ol>
            <li>Giao diện và API chạy trên Cloudflare Worker.</li>
            <li>Lyrics và ảnh bìa tự chỉnh được lưu trong Cloudflare D1.</li>
            <li>Không cần nhập URL khi dùng cấu hình mặc định.</li>
          </ol>
        </article>

        <article className="settings-card">
          <span>Đồng bộ lời</span>
          <h3>Offset theo từng bài</h3>
          {currentTrack ? (
            <>
              <p>
                <strong>Đang chọn:</strong> {currentTrack.title} · {currentTrack.artist}
              </p>
              <p>
                <strong>Offset hiện tại:</strong> {formatOffset(currentLyricOffset)}. Giá trị dương làm lyric chạy sớm
                hơn, giá trị âm làm lyric chạy chậm hơn.
              </p>
              <div className="settings-actions">
                <button type="button" className="ghost-pill" onClick={() => actions.nudgeLyricOffset(currentTrack.id, -0.5)}>
                  -0.5 giây
                </button>
                <button type="button" className="ghost-pill" onClick={() => actions.nudgeLyricOffset(currentTrack.id, 0.5)}>
                  +0.5 giây
                </button>
                <button type="button" className="action-pill" onClick={() => actions.resetLyricOffset(currentTrack.id)}>
                  Reset bài này
                </button>
              </div>
              <p>
                Phím tắt trong Player: <code>[</code> chậm hơn, <code>]</code> sớm hơn, <code>\</code> reset.
              </p>
            </>
          ) : (
            <p>Chọn một bài hát trước để lưu offset riêng theo từng bài.</p>
          )}
        </article>
      </section>
    </div>
  )
}

function formatOffset(value: number) {
  const rounded = Math.round((Number(value) || 0) * 10) / 10
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${rounded > 0 ? '+' : ''}${text}s`
}
