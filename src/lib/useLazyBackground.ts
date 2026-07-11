import { useEffect, useRef, useState } from 'react'

/**
 * Returns a ref to attach to a DOM element and a boolean indicating whether it
 * has entered the viewport. The actual background-image CSS is only applied once
 * the element is near the viewport, preventing offscreen network requests.
 */
export function useLazyBackground(url: string) {
  const ref = useRef<HTMLElement>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    if (!url || isVisible) return
    const element = ref.current
    if (!element) return

    if (!('IntersectionObserver' in window)) {
      // Fallback for environments without IntersectionObserver
      setIsVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' } // Load slightly before entering viewport
    )

    observer.observe(element)
    return () => observer.disconnect()
  }, [url, isVisible])

  return { ref, isVisible }
}
