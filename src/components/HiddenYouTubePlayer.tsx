import { useEffect, useEffectEvent, useRef } from 'react'
import { usePlayer, getCurrentTrack } from '../store/player'
import { loadYouTubeApi, type YouTubePlayerApi } from '../services/youtubePlayer'

export function HiddenYouTubePlayer() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YouTubePlayerApi | null>(null)
  const loadedVideoIdRef = useRef('')
  const intervalRef = useRef<number | null>(null)
  const seekTimeoutRef = useRef<number | null>(null)
  const pendingPlayRef = useRef(false)
  const pendingSeekRef = useRef<{ target: number; wasPlaying: boolean; corrected: boolean } | null>(null)
  const state = usePlayer()
  const { actions } = state
  const currentTrack = getCurrentTrack(state)

  const syncProgress = useEffectEvent(() => {
    const player = playerRef.current
    if (!player || pendingSeekRef.current) return

    const progress = player.getCurrentTime?.() || 0
    const duration = player.getDuration?.() || 0
    actions.syncProgress(progress, duration)
  })

  const handleReady = useEffectEvent(() => {
    const player = playerRef.current
    if (!player || !currentTrack) return

    player.setVolume(Math.round(state.volume * 100))
    player.setPlaybackRate(state.playbackRate)

    if (state.isPlaying) {
      player.loadVideoById(currentTrack.id)
    } else {
      player.cueVideoById(currentTrack.id)
    }

    loadedVideoIdRef.current = currentTrack.id
  })

  const handleStateChange = useEffectEvent((event: { data?: number }) => {
    const YT = window.YT
    if (!YT) return

    if (
      pendingPlayRef.current &&
      (event.data === YT.PlayerState.BUFFERING || event.data === YT.PlayerState.CUED)
    ) {
      pendingPlayRef.current = false
      playerRef.current?.playVideo()
      return
    }

    if (event.data === YT.PlayerState.PLAYING) {
      const pendingSeek = pendingSeekRef.current
      const player = playerRef.current
      if (pendingSeek && player) {
        const actualTime = player.getCurrentTime()
        if (!pendingSeek.corrected && Math.abs(actualTime - pendingSeek.target) > 1.25) {
          pendingSeek.corrected = true
          player.seekTo(pendingSeek.target, true)
          if (pendingSeek.wasPlaying) player.playVideo()
        } else {
          pendingSeekRef.current = null
          if (seekTimeoutRef.current !== null) {
            window.clearTimeout(seekTimeoutRef.current)
            seekTimeoutRef.current = null
          }
        }
      }
      actions.setPlaying(true)
    }

    if (event.data === YT.PlayerState.PAUSED) {
      if (pendingSeekRef.current?.wasPlaying) return
      pendingSeekRef.current = null
      if (seekTimeoutRef.current !== null) {
        window.clearTimeout(seekTimeoutRef.current)
        seekTimeoutRef.current = null
      }
      actions.setPlaying(false)
    }

    if (event.data === YT.PlayerState.ENDED) {
      actions.handleTrackEnd()
    }
  })

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement ||
      (document.activeElement as HTMLElement)?.isContentEditable
    ) {
      return
    }

    if (event.key === 'ArrowLeft') {
      actions.seek(Math.max(0, state.progress - 5))
    } else if (event.key === 'ArrowRight') {
      actions.seek(state.progress + 5)
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function setup() {
      const YT = await loadYouTubeApi()
      if (cancelled || !hostRef.current) return

      const player = new YT.Player(hostRef.current, {
        width: '1',
        height: '1',
        videoId: currentTrack?.id || '',
        playerVars: {
          autoplay: state.isPlaying ? 1 : 0,
          controls: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            handleReady()
          },
          onStateChange: (event) => {
            handleStateChange(event)
          },
          onError: () => {
            actions.handleTrackEnd()
          },
        },
      })

      playerRef.current = player
      intervalRef.current = window.setInterval(() => {
        syncProgress()
      }, 220)
    }

    setup().catch(() => {
      actions.setPlaying(false)
    })

    return () => {
      cancelled = true

      if (intervalRef.current) {
        window.clearInterval(intervalRef.current)
      }
      if (seekTimeoutRef.current !== null) {
        window.clearTimeout(seekTimeoutRef.current)
      }

      playerRef.current?.destroy()
      playerRef.current = null
    }
  }, [])

  useEffect(() => {
    const player = playerRef.current
    if (!player || !currentTrack) return

    if (loadedVideoIdRef.current === currentTrack.id) return

    player.setVolume(Math.round(state.volume * 100))
    player.setPlaybackRate(state.playbackRate)
    loadedVideoIdRef.current = currentTrack.id

    if (state.isPlaying) {
      pendingPlayRef.current = true
      player.loadVideoById(currentTrack.id)
    } else {
      pendingPlayRef.current = false
      player.cueVideoById(currentTrack.id)
    }
  }, [currentTrack?.id, state.playbackRate])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return

    player.setVolume(Math.round(state.volume * 100))
  }, [state.volume])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return

    player.setPlaybackRate(state.playbackRate)
  }, [state.playbackRate])

  useEffect(() => {
    const player = playerRef.current
    if (!player || !currentTrack) return

    if (state.isPlaying) {
      pendingPlayRef.current = false
      player.playVideo()
    } else {
      pendingPlayRef.current = false
      player.pauseVideo()
    }
  }, [state.isPlaying])

  useEffect(() => {
    const player = playerRef.current
    if (!player || state.pendingSeek === null) return

    pendingSeekRef.current = {
      target: state.pendingSeek,
      wasPlaying: state.isPlaying,
      corrected: false,
    }
    player.seekTo(state.pendingSeek, true)
    actions.acknowledgeSeek()

    if (seekTimeoutRef.current !== null) {
      window.clearTimeout(seekTimeoutRef.current)
    }
    seekTimeoutRef.current = window.setTimeout(() => {
      pendingSeekRef.current = null
      seekTimeoutRef.current = null
    }, 10000)
  }, [state.pendingSeek])

  return (
    <div className="yt-host" aria-hidden="true">
      <div ref={hostRef} />
    </div>
  )
}
