import { randomUUID } from 'crypto';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { ownedHome } from '../../../src/session/codex-process';

// Runs natively on Linux, macOS and Windows (cross-platform CI): the attempt
// home is created with path.join, so ownership must use the same separator.
describe('Codex ownedHome', () => {
  const root = join(tmpdir(), 'state', 'codex', 'a'.repeat(64));

  test('accepts the attempt home the host creates', () => {
    expect(ownedHome(root, join(root, 'attempt-' + randomUUID()))).toBe(true);
  });

  test('rejects other directories and malformed attempt names', () => {
    const id = randomUUID();
    expect(ownedHome(root, join(root + 'x', 'attempt-' + id))).toBe(false);
    expect(ownedHome(root, join(root, 'attempt-' + id, '..', '..'))).toBe(false);
    expect(ownedHome(root, join(root, 'attempt-not-a-uuid'))).toBe(false);
    expect(ownedHome(root, 42)).toBe(false);
  });

  test('container homes keep the POSIX container layout', () => {
    const id = randomUUID();
    expect(ownedHome(root, homedir() + '/.gateway-codex-' + id, 'app')).toBe(true);
    expect(ownedHome(root, join(root, 'attempt-' + id), 'app')).toBe(false);
  });
});
