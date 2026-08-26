import * as fs from 'fs';
import * as path from 'path';
import { CORE_HELP, NAME_W, NOUN_NAME_W, helpRow } from '../../src/cli/index';

const SOURCE = path.resolve(__dirname, '../../src/cli/index.ts');

/** The `case 'x':` labels of runCli()'s command switch — the actual set of core
 *  commands the dispatcher accepts, read from the source rather than restated
 *  here, so this test cannot agree with a stale copy of the list. */
function dispatchedCommands(): string[] {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('switch (command) {');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n    }', start));
  return [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
}

/** The first word of a help row is the command it documents. */
const commandOf = (name: string) => name.split(' ')[0];

/**
 * Help and dispatch are two hand-maintained lists, and nothing in the compiler
 * connects them. That gap is exactly how `logs` came to be accepted by the
 * dispatcher while appearing nowhere in help — reported in review, not by any
 * test. These specs close it in both directions.
 */
describe('core help table', () => {
  it('documents every command the dispatcher accepts', () => {
    const documented = new Set(CORE_HELP.map(([name]) => commandOf(name)));
    // `gateway start` has its own section above the table (it is the only
    // command that boots a server), so `gateway` is documented either way.
    for (const command of dispatchedCommands()) {
      expect(documented.has(command)).toBe(true);
    }
  });

  it('documents nothing the dispatcher does not accept', () => {
    const dispatched = new Set(dispatchedCommands());
    // `version` is matched by VERSION_ALIASES before the switch is reached.
    const beforeSwitch = new Set(['version']);
    for (const [name] of CORE_HELP) {
      const command = commandOf(name);
      expect(dispatched.has(command) || beforeSwitch.has(command)).toBe(true);
    }
  });

  it('finds a switch to read, so a refactor cannot make this test vacuous', () => {
    expect(dispatchedCommands().length).toBeGreaterThan(5);
    expect(dispatchedCommands()).toContain('doctor');
  });
});

describe('helpRow', () => {
  const plain = (s: string) => s;

  it('pads the name to the column width and puts the description beside it', () => {
    const [line, ...rest] = helpRow('doctor', 'Check things', plain);
    expect(rest).toHaveLength(0);
    expect(line).toBe(`  ${'doctor'.padEnd(NAME_W)}Check things`);
    expect(line.indexOf('Check things')).toBe(2 + NAME_W);
  });

  /** No current name is this long, so only a direct test reaches this branch —
   *  and the layout test cannot see it, since it reads whole rows. */
  it('wraps a name at or past the column width onto two aligned lines', () => {
    const long = 'x'.repeat(NAME_W);
    expect(helpRow(long, 'Description', plain)).toEqual([`  ${long}`, `  ${' '.repeat(NAME_W)}Description`]);
    // The description still starts in the usual column, so the table holds.
    expect(helpRow(long, 'Description', plain)[1].indexOf('Description')).toBe(2 + NAME_W);
  });

  it('honours a caller-supplied width, which is how noun help stays aligned', () => {
    const [line] = helpRow('crons list', 'List cron jobs', plain, NOUN_NAME_W);
    expect(line.indexOf('List cron jobs')).toBe(2 + NOUN_NAME_W);
  });

  /** Colour is applied to the padded name, never to the padding, or the escape
   *  codes would count toward the column width and skew every row. */
  it('paints the name only, leaving the column width untouched', () => {
    const paint = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const [line] = helpRow('doctor', 'Check things', paint);
    // eslint-disable-next-line no-control-regex
    expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toBe(`  ${'doctor'.padEnd(NAME_W)}Check things`);
  });
});
