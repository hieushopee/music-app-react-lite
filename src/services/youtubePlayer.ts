export interface YouTubePlayerApi {
  loadVideoById(videoId: string): void
  cueVideoById(videoId: string): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead?: boolean): void
  setVolume(volume: number): void
  setPlaybackRate(rate: number): void
  getCurrentTime(): number
  getDuration(): number
  destroy(): void
}

interface PlayerEvent {
  target: YouTubePlayerApi
  data?: number
}

interface YouTubeNamespace {
  PlayerState: {
    ENDED: number
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
  }
  Player: new (
    element: HTMLElement,
    options: {
      width: string
      height: string
      videoId: string
      playerVars: Record<string, string | number>
      events: {
        onReady: (event: PlayerEvent) => void
        onStateChange: (event: PlayerEvent) => void
        onError: (event: PlayerEvent) => void
      }
    }
  ) => YouTubePlayerApi
}

declare global {
  interface Window {
    YT?: YouTubeNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let loadingPromise: Promise<YouTubeNamespace> | null = null

export function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT)
  }

  if (loadingPromise) {
    return loadingPromise
  }

  loadingPromise = new Promise<YouTubeNamespace>((resolve, reject) => {
    const fail = (error: Error) => {
      loadingPromise = null
      reject(error)
    }
    const timeout = window.setTimeout(() => {
      fail(new Error('Hết thời gian tải YouTube IFrame API.'))
    }, 10000)
    let script = document.querySelector<HTMLScriptElement>('script[data-yt-frame-api]')

    if (script?.dataset.ytFrameApiFailed === 'true') {
      script.remove()
      script = null
    }

    if (!script) {
      script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.dataset.ytFrameApi = 'true'
      script.onerror = () => {
        window.clearTimeout(timeout)
        script?.remove()
        if (script) script.dataset.ytFrameApiFailed = 'true'
        fail(new Error('Không tải được YouTube IFrame API.'))
      }
      document.body.appendChild(script)
    }

    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timeout)
      if (!window.YT?.Player) {
        fail(new Error('YouTube API chưa sẵn sàng.'))
        return
      }

      resolve(window.YT)
    }
  })

  return loadingPromise
}
