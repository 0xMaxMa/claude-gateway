const CRON_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function cronValue(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : (CRON_NAMES[token.slice(0, 3).toLowerCase()] ?? NaN);
}

/**
 * True when a cron expression contains a range whose start is above its end,
 * such as `17-9` or `FRI-MON`. node-cron accepts these and silently swaps the
 * ends, so `0 17-9 * * *` would run at 9..17 instead of overnight.
 */
export function hasReversedCronRange(expr: string): boolean {
  return expr.split(/\s+/).some((field) =>
    field.split(',').some((part) => {
      const ends = part.split('/')[0].split('-');
      return ends.length === 2 && cronValue(ends[0]) > cronValue(ends[1]);
    }),
  );
}
