/** Relative task timestamps for channel menus; older updates use explicit UTC. */
export function formatTaskUpdatedAt(updatedAt: number, now = Date.now()): string {
  const age = Math.max(0, now - updatedAt);
  if (age > 86_400_000) return new Date(updatedAt).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
  const seconds = Math.floor(age / 1000);
  const [value, unit] = seconds < 60 ? [seconds, 'second']
    : seconds < 3600 ? [Math.floor(seconds / 60), 'minute']
    : [Math.floor(seconds / 3600), 'hour'];
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}
