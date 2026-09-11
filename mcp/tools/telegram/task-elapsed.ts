/** Wall time since the first worker attempt, excluding time in the initial queue. */
export function formatTaskElapsed(startedAt?: number, finishedAt?: number, now = Date.now()): string {
  if (startedAt === undefined) return 'Not started';
  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return `${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${seconds % 60}s`;
}
