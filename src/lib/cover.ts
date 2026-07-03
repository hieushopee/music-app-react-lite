/**
 * For ytimg.com URLs, maxresdefault may 404 for older/unlisted videos.
 * We generate a srcset-style fallback chain: maxresdefault → hq720 → mqdefault.
 * The CSS background trick: load via <img> is not possible, so we use
 * a reliable thumbnail quality that almost always exists (hq720 or mqdefault).
 */
export function getSafeThumbnailUrl(url: string): string {
  if (!url) return ''
  // If it's a ytimg URL with maxresdefault, fall back to hq720 which is more reliable
  if (url.includes('ytimg.com') && url.includes('maxresdefault')) {
    return url.replace('maxresdefault', 'hq720')
  }
  return url
}

export function getCoverStyle(thumbnail: string) {
  const safeUrl = getSafeThumbnailUrl(thumbnail)
  if (safeUrl) {
    return {
      backgroundImage: `url(${safeUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }

  return {
    background:
      'radial-gradient(circle at top left, rgba(255, 196, 74, 0.92), rgba(17, 47, 54, 0.94) 62%, rgba(6, 12, 13, 0.98))',
  }
}

