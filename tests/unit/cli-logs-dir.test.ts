import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { explicitConfigWarning, listLogStreamIds, readLogDir, resolveLogDir } from '../../src/cli/logs-dir';

/**
 * The shared log-directory helper (issue #435).
 *
 * `debug-bundle` owned this privately; `gateway logs` needs exactly the same
 * three behaviours, and a second copy is how they drift. The tilde case is not
 * hypothetical — the shipped config template writes `~/.claude-gateway/logs`
 * literally, and a reader that forgets to expand it gets an ENOENT that reads
 * like "the directory is empty".
 */
describe('cli logs-dir', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-logs-dir-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.GATEWAY_CONFIG;
  });

  it('U-LD-01: --logDir wins and its leading ~ is expanded', () => {
    expect(resolveLogDir({ logDir: '~/somewhere/logs' })).toBe(
      path.join(os.homedir(), 'somewhere', 'logs'),
    );
  });

  it('U-LD-02: a ~ in the config file gateway.logDir is expanded too', () => {
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ gateway: { logDir: '~/.claude-gateway/logs' } }));

    expect(resolveLogDir({ config: cfg })).toBe(
      path.join(os.homedir(), '.claude-gateway', 'logs'),
    );
  });

  it('U-LD-03: --logDir takes precedence over the config file', () => {
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ gateway: { logDir: '/from/config' } }));

    expect(resolveLogDir({ config: cfg, logDir: '/from/flag' })).toBe('/from/flag');
  });

  it('U-LD-04: with neither, it falls back to the default location', () => {
    process.env.GATEWAY_CONFIG = path.join(dir, 'no-such-config.json');

    expect(resolveLogDir({})).toBe(path.join(os.homedir(), '.claude-gateway', 'logs'));
  });

  it('U-LD-05: a missing directory reports the reason, not an empty listing', () => {
    const missing = path.join(dir, 'gone');
    const listing = readLogDir(missing);

    expect(listing.names).toEqual([]);
    expect(listing.error).toBe(`${missing} does not exist`);
  });

  it('U-LD-06: a path that is a file reports ENOTDIR distinctly', () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');

    expect(readLogDir(file).error).toBe(`${file} is not a directory`);
  });

  it('U-LD-07: an empty but readable directory is not an error', () => {
    expect(readLogDir(dir)).toEqual({ names: [] });
  });

  it('U-LD-08: stream ids exclude rotated generations and non-log files', () => {
    for (const n of ['gateway.log', 'gateway.log.1', 'gateway.log.2', 'aika:receiver.log', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, n), 'x');
    }

    expect(listLogStreamIds(dir).ids).toEqual(['aika:receiver', 'gateway']);
  });

  it('U-LD-09: listing ids surfaces the directory error instead of claiming none exist', () => {
    const missing = path.join(dir, 'gone');
    const { ids, error } = listLogStreamIds(missing);

    expect(ids).toEqual([]);
    expect(error).toBe(`${missing} does not exist`);
  });

  // `loadCliConfig` cannot distinguish "missing", "unreadable" and "malformed" —
  // all three come back as `{}` — so resolveLogDir silently answers with the
  // default directory. Without a warning the caller then reports "no log file
  // at <default>", naming a directory the operator never asked about while the
  // typo in --config goes unmentioned.
  it('U-LD-10: an explicit --config that does not exist is reported, not silently defaulted', () => {
    const missing = path.join(dir, 'nope.json');

    const warning = explicitConfigWarning({ config: missing });

    expect(warning).toContain(missing);
    expect(warning).toContain('ENOENT');
    // The fallback itself still happens — the warning is what makes it legible.
    expect(resolveLogDir({ config: missing })).toBe(path.join(os.homedir(), '.claude-gateway', 'logs'));
  });

  it('U-LD-11: an explicit --config that is not valid JSON is reported', () => {
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, '{ "gateway": ');

    expect(explicitConfigWarning({ config: broken })).toContain('not valid JSON');
  });

  it('U-LD-12: a readable config, no --config at all, or --logDir winning are all silent', () => {
    const good = path.join(dir, 'config.json');
    fs.writeFileSync(good, JSON.stringify({ gateway: { logDir: dir } }));

    expect(explicitConfigWarning({ config: good })).toBeUndefined();
    // No --config: a fresh install has no config file and the default log
    // directory is the right answer for it, so there is nothing to warn about.
    expect(explicitConfigWarning({})).toBeUndefined();
    // --logDir wins outright, so a bad --config alongside it was never consulted.
    expect(explicitConfigWarning({ logDir: dir, config: path.join(dir, 'nope.json') })).toBeUndefined();
  });
});
