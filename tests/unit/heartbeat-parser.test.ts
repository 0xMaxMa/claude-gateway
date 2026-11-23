import * as path from 'path';
import * as fs from 'fs';
import {
  parseHeartbeat,
  parseInterval,
  InvalidCronError,
  InvalidIntervalError,
  MissingPromptError,
  MissingNameError,
  AmbiguousScheduleError,
  MissingScheduleError,
} from '../../src/heartbeat/parser';

const FIXTURES = path.join(__dirname, '../fixtures/heartbeat');

describe('heartbeat-parser', () => {
  // -------------------------------------------------------------------------
  // U-HP-01: Parse cron-expression task
  // -------------------------------------------------------------------------
  it('U-HP-01: parses a task with a cron expression', () => {
    const content = `tasks:
  - name: morning-brief
    cron: "0 8 * * *"
    prompt: "Give Max a morning summary."
`;
    const tasks = parseHeartbeat(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('morning-brief');
    expect(tasks[0].cron).toBe('0 8 * * *');
    expect(tasks[0].prompt).toBe('Give Max a morning summary.');
  });

  // -------------------------------------------------------------------------
  // U-HP-02: Parse interval task → convert to cron
  // -------------------------------------------------------------------------
  it('U-HP-02: parses an interval task and converts it to cron', () => {
    const content = `tasks:
  - name: idle-checkin
    interval: 2h
    prompt: "Check if anything needs attention."
`;
    const tasks = parseHeartbeat(content);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('idle-checkin');
    expect(tasks[0].cron).toBe('0 */2 * * *');
  });

  // -------------------------------------------------------------------------
  // U-HP-03: Parse multiple tasks
  // -------------------------------------------------------------------------
  it('U-HP-03: parses multiple tasks from a file', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'valid-cron.md'), 'utf-8');
    const tasks = parseHeartbeat(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].name).toBe('morning-brief');
    expect(tasks[1].name).toBe('weekly-review');
  });

  // -------------------------------------------------------------------------
  // U-HP-04: Invalid cron expression
  // -------------------------------------------------------------------------
  it('U-HP-04: throws InvalidCronError for invalid cron expression', () => {
    const content = `tasks:
  - name: bad-task
    cron: "99 99 * * *"
    prompt: "Invalid cron."
`;
    expect(() => parseHeartbeat(content)).toThrow(InvalidCronError);
    expect(() => parseHeartbeat(content)).toThrow('bad-task');
  });

  // -------------------------------------------------------------------------
  // U-HP-05: Invalid interval format
  // -------------------------------------------------------------------------
  it('U-HP-05: throws InvalidIntervalError for an unrecognised interval', () => {
    const content = `tasks:
  - name: bad-interval
    interval: "2hours"
    prompt: "Bad interval."
`;
    expect(() => parseHeartbeat(content)).toThrow(InvalidIntervalError);
    expect(() => parseHeartbeat(content)).toThrow('bad-interval');
  });

  // -------------------------------------------------------------------------
  // U-HP-06: Task missing prompt
  // -------------------------------------------------------------------------
  it('U-HP-06: throws MissingPromptError when prompt is absent', () => {
    const content = `tasks:
  - name: no-prompt-task
    cron: "0 8 * * *"
`;
    expect(() => parseHeartbeat(content)).toThrow(MissingPromptError);
    expect(() => parseHeartbeat(content)).toThrow('no-prompt-task');
  });

  // -------------------------------------------------------------------------
  // U-HP-07: Task missing name
  // -------------------------------------------------------------------------
  it('U-HP-07: throws MissingNameError when name is absent', () => {
    const content = `tasks:
  - cron: "0 8 * * *"
    prompt: "Nameless task."
`;
    expect(() => parseHeartbeat(content)).toThrow(MissingNameError);
  });

  // -------------------------------------------------------------------------
  // U-HP-08: Both cron and interval set
  // -------------------------------------------------------------------------
  it('U-HP-08: throws AmbiguousScheduleError when both cron and interval are set', () => {
    const content = `tasks:
  - name: ambiguous-task
    cron: "0 8 * * *"
    interval: 2h
    prompt: "Both specified."
`;
    expect(() => parseHeartbeat(content)).toThrow(AmbiguousScheduleError);
    expect(() => parseHeartbeat(content)).toThrow('ambiguous-task');
  });

  // -------------------------------------------------------------------------
  // U-HP-09: Neither cron nor interval
  // -------------------------------------------------------------------------
  it('U-HP-09: throws MissingScheduleError when neither cron nor interval is set', () => {
    const content = `tasks:
  - name: no-schedule-task
    prompt: "No schedule."
`;
    expect(() => parseHeartbeat(content)).toThrow(MissingScheduleError);
    expect(() => parseHeartbeat(content)).toThrow('no-schedule-task');
  });

  // -------------------------------------------------------------------------
  // U-HP-10: Empty tasks list
  // -------------------------------------------------------------------------
  it('U-HP-10: returns empty array for empty tasks list', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'empty-tasks.md'), 'utf-8');
    const tasks = parseHeartbeat(content);
    expect(tasks).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // U-HP-11: No tasks section (plain markdown)
  // -------------------------------------------------------------------------
  it('U-HP-11: returns empty array when there is no tasks section', () => {
    const content = `# Heartbeat

This file has no YAML tasks section at all.
Just regular markdown content.
`;
    const tasks = parseHeartbeat(content);
    expect(tasks).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // U-HP-12: Interval conversion 30m
  // -------------------------------------------------------------------------
  it('U-HP-12: converts 30m interval to */30 * * * *', () => {
    expect(parseInterval('30m')).toEqual({ cron: '*/30 * * * *' });
  });

  // -------------------------------------------------------------------------
  // U-HP-13: Interval conversion 1d
  // -------------------------------------------------------------------------
  it('U-HP-13: converts 1d interval to 0 0 * * *', () => {
    expect(parseInterval('1d')).toEqual({ cron: '0 0 * * *' });
  });

  // Additional interval conversions
  it('converts 1w to 0 0 * * 0', () => {
    expect(parseInterval('1w')).toEqual({ cron: '0 0 * * 0' });
  });

  it('converts 1h to 0 */1 * * *', () => {
    expect(parseInterval('1h')).toEqual({ cron: '0 */1 * * *' });
  });

  it('returns null for invalid interval format', () => {
    expect(parseInterval('2hours')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('')).toBeNull();
  });

  // Valid cron expressions test
  it('accepts valid cron expressions with ranges, steps, and lists', () => {
    const validCrons = [
      '0 8 * * *',
      '*/30 * * * *',
      '0 */2 * * *',
      '0 0 * * 0',
      '0 9-17 * * 1-5',
      '0 8,12,18 * * *',
    ];

    for (const cron of validCrons) {
      const content = `tasks:
  - name: test-task
    cron: "${cron}"
    prompt: "Test prompt."
`;
      expect(() => parseHeartbeat(content)).not.toThrow();
      const tasks = parseHeartbeat(content);
      expect(tasks[0].cron).toBe(cron);
    }
  });

  // Invalid cron fields
  it('throws InvalidCronError for wrong number of fields', () => {
    const content = `tasks:
  - name: bad-fields
    cron: "0 8 *"
    prompt: "Three fields only."
`;
    expect(() => parseHeartbeat(content)).toThrow(InvalidCronError);
  });

  // Fixture file: valid-interval.md
  it('correctly parses valid-interval.md fixture with 2 tasks', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'valid-interval.md'), 'utf-8');
    const tasks = parseHeartbeat(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].cron).toBe('0 */2 * * *');
    expect(tasks[1].cron).toBe('*/30 * * * *');
  });

  // Fixture file: invalid-cron.md
  it('throws InvalidCronError for invalid-cron.md fixture', () => {
    const content = fs.readFileSync(path.join(FIXTURES, 'invalid-cron.md'), 'utf-8');
    expect(() => parseHeartbeat(content)).toThrow(InvalidCronError);
  });
});

// ---------------------------------------------------------------------------
// Issue #652: cron validation must match node-cron, the runtime scheduler
// ---------------------------------------------------------------------------
describe('heartbeat-parser cron validation matches node-cron (#652)', () => {
  function cronTask(cron: string): string {
    return `tasks:
  - name: test-task
    cron: "${cron}"
    prompt: "Test prompt."
`;
  }

  it.each([
    '0 9-11,13-17 * * 1-5', // list of ranges
    '0 9 * * MON-FRI', // named day range
    '0 9 * * mon', // named day, lower case
    '0 8 * JAN *', // named month
    '0 9 * * 7', // Sunday as 7 outside a range
    '0 9 * * SUN-SAT',
    '0 9 * * Monday-Friday', // full names
  ])('accepts valid cron "%s"', (cron) => {
    const tasks = parseHeartbeat(cronTask(cron));
    expect(tasks[0].cron).toBe(cron);
  });

  it.each([
    '5/15 * * * *', // node-cron rejects a bare N/step base; schedule() would throw
    '1-60 * * * *', // out-of-range range end
    '* * * * * *', // 6-field (seconds) cron is not a heartbeat schedule
    '0 8 ? * *',
    '0 17-9 * * *', // node-cron would silently run this as 9-17
    '0 9 * * FRI-MON', // node-cron would silently run this as MON-FRI
    '0 9 * * 5-1',
    '0 9 * DEC-JAN *',
    '0 9 * * 1-7', // node-cron reads 7 as 0 first, so this would run Sun-Mon
    '0 9 * * 5-7',
    '0 9 * * 0-7',
    '0 9-17-8 * * *', // multi-dash range
  ])('rejects cron "%s" with InvalidCronError', (cron) => {
    expect(() => parseHeartbeat(cronTask(cron))).toThrow(InvalidCronError);
  });
});

// ---------------------------------------------------------------------------
// Issue #652: intervals that do not divide their cycle must keep a fixed gap
// ---------------------------------------------------------------------------
describe('heartbeat-parser interval schedules (#652)', () => {
  function intervalTask(interval: string): string {
    return `tasks:
  - name: every
    interval: ${interval}
    prompt: "Check in."
`;
  }

  it.each([
    ['45m', 45 * 60_000],
    ['7m', 7 * 60_000],
    ['5h', 5 * 3_600_000],
    ['23h', 23 * 3_600_000],
  ])('"%s" becomes a fixed %i ms interval instead of an uneven cron', (interval, ms) => {
    const [task] = parseHeartbeat(intervalTask(interval));
    expect(task.cron).toBeUndefined();
    expect(task.intervalMs).toBe(ms);
  });

  it.each([
    ['1m', '*/1 * * * *'],
    ['15m', '*/15 * * * *'],
    ['30m', '*/30 * * * *'],
    ['1h', '0 */1 * * *'],
    ['6h', '0 */6 * * *'],
    ['12h', '0 */12 * * *'],
    ['1d', '0 0 * * *'],
    ['1w', '0 0 * * 0'],
  ])('"%s" still maps to wall-clock cron "%s"', (interval, cron) => {
    const [task] = parseHeartbeat(intervalTask(interval));
    expect(task.cron).toBe(cron);
    expect(task.intervalMs).toBeUndefined();
  });

  it.each(['0m', '60m', '0h', '24h', '2d', '2w', '2hours'])(
    'still rejects interval "%s"',
    (interval) => {
      expect(() => parseHeartbeat(intervalTask(interval))).toThrow(InvalidIntervalError);
    },
  );
});
