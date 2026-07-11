import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { formatDuration } from '../lib/format'
import { getCoverStyle } from '../lib/cover'
import { usePlayer } from '../store/player'

export function AppShell() {
  const state = usePlayer()
  const { currentTrack, effectiveDuration, actions } = state
  const navigate = useNavigate()
  const location = useLocation()

  function openPlayer() {
    navigate('/player')
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand-block">
          <div className="brand-mark" />
          <div>
            <div className="brand-kicker">Âm nhạc trực tuyến</div>
            <h1>PulseFrame</h1>
          </div>
        </div>

        <nav className="site-nav" aria-label="Điều hướng chính">
          <NavLink to="/" className={({ isActive }) => `nav-pill${isActive ? ' is-active' : ''}`}>
            Trang chủ
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-pill${isActive ? ' is-active' : ''}`}>
            Cài đặt
          </NavLink>
        </nav>
      </header>

      <main className="page-shell">
        <Outlet />
      </main>

      {currentTrack && location.pathname !== '/player' ? (
        <aside
          className="mini-player"
          role="button"
          tabIndex={0}
          onClick={openPlayer}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openPlayer()
            }
          }}
        >
          <div className="mini-player__cover" style={getCoverStyle(currentTrack.thumbnail)} />
          <div className="mini-player__meta">
            <strong>{currentTrack.title}</strong>
            <span>
              {currentTrack.artist} · {formatDuration(state.progress)} / {formatDuration(effectiveDuration)}
            </span>
          </div>
          <div className="mini-player__actions">
            <button
              type="button"
              className="mini-player__toggle"
              aria-label={state.isPlaying ? 'Tạm dừng' : 'Phát'}
              onClick={(event) => {
                event.stopPropagation()
                actions.toggle()
              }}
            >
              {state.isPlaying ? '❚❚' : '▶'}
            </button>
            <span className="mini-player__open">Player</span>
          </div>
        </aside>
      ) : null}
    </div>
  )
}
