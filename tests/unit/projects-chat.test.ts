import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectTrusted } from '../../src/projects/chat';
import { GatewayConfig } from '../../src/types';

let base: string;
let realRoot: string;
let linkRoot: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-chat-')));
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
  ({ gateway: { logDir: base, projects: { root, trusted } }, agents: [] }) as unknown as GatewayConfig;

describe('projectTrusted', () => {
  it.each([
    ['the real root', () => realRoot],
    ['a symlinked root', () => linkRoot],
  ])('trusts a listed real folder under %s', async (_label, root) => {
    expect(await projectTrusted(config(root(), ['app']), 'app')).toBe(true);
  });

  it.each([
    ['the real root', () => realRoot],
    ['a symlinked root', () => linkRoot],
  ])('does not trust a listed project that is a symlink under %s', async (_label, root) => {
    expect(await projectTrusted(config(root(), ['alias']), 'alias')).toBe(false);
  });

  it('does not trust a folder missing from the list', async () => {
    expect(await projectTrusted(config(linkRoot, ['other']), 'app')).toBe(false);
  });
});
