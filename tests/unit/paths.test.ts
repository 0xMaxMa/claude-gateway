import * as os from 'os';
import * as path from 'path';
import { expandHome } from '../../src/utils/paths';
import { expandHome as fromHttpClient } from '../../src/cli/http-client';

/**
 * This lived in four places — the server entry, the CLI's http client, the
 * service installer and the knowledge config — each with its own slice offset.
 * They agreed by luck rather than by construction, which is the kind of drift
 * that produced the `debug-bundle` tilde bug.
 */
describe('expandHome', () => {
  it('expands a leading ~/', () => {
    expect(expandHome('~/.claude-gateway/logs')).toBe(path.join(os.homedir(), '.claude-gateway/logs'));
  });

  it('expands a bare ~', () => {
    expect(expandHome('~')).toBe(os.homedir());
  });

  it('leaves everything else alone', () => {
    expect(expandHome('/var/log/gateway')).toBe('/var/log/gateway');
    expect(expandHome('relative/path')).toBe('relative/path');
    // Only a leading `~/` is a home reference; `~foo` is another user's home in
    // shell syntax, which this deliberately does not try to resolve.
    expect(expandHome('~backup/logs')).toBe('~backup/logs');
    expect(expandHome('/opt/~/x')).toBe('/opt/~/x');
    expect(expandHome('')).toBe('');
  });

  it('is the same function the CLI re-exports, not a second copy', () => {
    expect(fromHttpClient).toBe(expandHome);
  });
});
