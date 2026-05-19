export function formatDuration(value: number) {
  const total = Math.max(Number(value) || 0, 0)
  const minutes = Math.floor(total / 60)
  const seconds = Math.floor(total % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
