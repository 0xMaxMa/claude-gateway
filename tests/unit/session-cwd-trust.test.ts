import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCwdResolver } from '../../src/files/session-cwd';
import { GatewayConfig } from '../../src/types';
import { silentLogger } from '../helpers/silent-logger';

let base: string;
let realRoot: string;
let linkRoot: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-cwd-trust-')));
  realRoot = path.join(base, 'real');
  linkRoot = path.join(base, 'link');
  fs.mkdirSync(path.join(realRoot, 'app'), { recursive: true });
  fs.symlinkSync(path.join(realRoot, 'app'), path.join(realRoot, 'alias'));
  fs.symlinkSync(realRoot, linkRoot);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const config = (root: string, trusted: string[]) =>
  ({ gateway: { logDir: base, files: { root, trusted } }, agents: [] }) as unknown as GatewayConfig;

async function trusted(root: string, list: string[], cwd: string): Promise<boolean> {
  const parsed = await createCwdResolver(config(root, list), silentLogger).parse(cwd);
  if (!parsed.ok) throw new Error(`cwd ${cwd} did not resolve: ${parsed.error}`);
  return parsed.value.trusted;
}

describe('cwd trust', () => {
  it.each([
    ['the real root', () => realRoot],
    ['a symlinked root', () => linkRoot],
  ])('trusts a listed real folder under %s', async (_label, root) => {
    expect(await trusted(root(), ['app'], 'app')).toBe(true);
  });

  it.each([
    ['the real root', () => realRoot],
    ['a symlinked root', () => linkRoot],
  ])('does not trust a listed folder that is a symlink under %s', async (_label, root) => {
    expect(await trusted(root(), ['alias'], 'alias')).toBe(false);
  });

  it('does not trust a folder missing from the list', async () => {
    expect(await trusted(linkRoot, ['other'], 'app')).toBe(false);
  });
});
