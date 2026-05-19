export function getCoverStyle(thumbnail: string) {
  if (thumbnail) {
    return {
      backgroundImage: `url(${thumbnail})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }

  return {
    background:
      'radial-gradient(circle at top left, rgba(255, 196, 74, 0.92), rgba(17, 47, 54, 0.94) 62%, rgba(6, 12, 13, 0.98))',
  }
}
