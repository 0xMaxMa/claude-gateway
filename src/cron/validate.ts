const CRON_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function cronValue(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : (CRON_NAMES[token.slice(0, 3).toLowerCase()] ?? NaN);
}

/**
 * True when a cron expression has a range that node-cron accepts but runs at
 * different values than written:
 * - a reversed range (`17-9`, `FRI-MON`), whose ends node-cron swaps;
 * - a range with more than one dash (`9-17-8`);
 * - a weekday range ending in 7 (`1-7`), because node-cron rewrites the first
 *   7 in the weekday field to 0 before it expands ranges.
 */
export function hasMisreadCronRange(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.some((field, i) => {
    const isWeekday = i === fields.length - 1;
    return field.split(',').some((part) => {
      const ends = part.split('/')[0].split('-');
      if (ends.length === 1) return false;
      if (ends.length > 2) return true;
      const [start, end] = ends.map(cronValue);
      return start > end || (isWeekday && (start === 7 || end === 7));
    });
  });
}
