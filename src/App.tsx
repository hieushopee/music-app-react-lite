import { Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { ArtistRail } from './components/ArtistRail'
import { HiddenYouTubePlayer } from './components/HiddenYouTubePlayer'
import { HomePage } from './pages/HomePage'
import { PlayerPage } from './pages/PlayerPage'
import { SettingsPage } from './pages/SettingsPage'

import { AlbumPage } from './pages/AlbumPage'

export default function App() {
  return (
    <>
      <HiddenYouTubePlayer />
      <ArtistRail />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/album/:id" element={<AlbumPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/player" element={<PlayerPage />} />
      </Routes>
    </>
  )
}
