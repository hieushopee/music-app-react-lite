import { useEffect, useState } from 'react'
import { getConfiguredApiBase, normalizeApiBase, testApiBase } from '../services/musicApi'
import { usePlayer } from '../store/player'

export function SettingsPage() {
  const state = usePlayer()
  const { currentTrack, actions } = state
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
      actions.setApiBase(normalized)
      setDraftBase(normalized)
      setStatusType('ok')
      setStatus(
        `Kết nối thành công: ${result?.source || 'ytmusic'} · test search OK (${result?.sampleCount || 0} kết quả mẫu) · đang dùng ${normalized || '/api'}`
      )
    } catch (error) {
      setStatusType('error')
      setStatus(
        error instanceof Error
          ? `Kết nối thất bại hoặc server không tìm nhạc được: ${error.message}`
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
      <section className="settings-card settings-card--wide">
        <span>Kết nối backend</span>
        <h2>Thiết lập API YouTube Music cho web React mới</h2>
        <p>
          Để chạy local, backend mặc định là <code>http://localhost:5174</code>. Nếu bạn deploy server riêng hoặc chạy
          trên máy khác trong LAN, điền URL vào đây rồi bấm kiểm tra.
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
          placeholder="http://192.168.x.x:5174"
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
            <strong>Ghi đè local:</strong> {state.apiBase || '(không có)'}
          </p>
          <p>
            <strong>Đang dùng:</strong> {activeBase}
          </p>
        </article>

        <article className="settings-card">
          <span>Cách chạy</span>
          <h3>Quy trình local</h3>
          <ol>
            <li>Vào thư mục `D:\music-app-react-lite`.</li>
            <li>Chạy `npm install` ở root và `npm install` trong `server`.</li>
            <li>Chạy `npm run dev` để mở cả web và API cùng lúc.</li>
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
