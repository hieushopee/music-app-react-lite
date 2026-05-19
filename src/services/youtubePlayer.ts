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
    const existing = document.querySelector<HTMLScriptElement>('script[data-yt-frame-api]')
    if (!existing) {
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.dataset.ytFrameApi = 'true'
      script.onerror = () => reject(new Error('Không tải được YouTube IFrame API.'))
      document.body.appendChild(script)
    }

    window.onYouTubeIframeAPIReady = () => {
      if (!window.YT) {
        reject(new Error('YouTube API chưa sẵn sàng.'))
        return
      }

      resolve(window.YT)
    }
  })

  return loadingPromise
}
