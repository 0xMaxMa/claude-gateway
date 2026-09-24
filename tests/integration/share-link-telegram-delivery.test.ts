/**
 * Integration test (#532, AC #6): a shared-file link, once minted, must
 * survive the REAL Telegram delivery formatting pipeline byte-for-byte.
 *
 * Before the fix, `ShareStore.mintShare` could produce a token containing
 * `_`, and `resolveTelegramReplyFormat` (the same function `DeliveryOutbox`
 * / `channelSender` call for every outgoing Telegram message, see
 * src/orchestration/delivery.ts:35) auto-detects `_..._` runs as italic
 * markdown and silently drops both underscore delimiters — corrupting the
 * URL into a dead link. This test exercises both real modules together
 * (no mocking of either) so a regression in either one is caught here.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShareStore } from '../../src/share/share-store';
import { resolveTelegramReplyFormat } from '../../src/telegram/markdown';

describe('shared link survives Telegram delivery formatting (#532)', () => {
  let baseDir: string;
  let store: ShareStore;

  beforeEach(() => {
    baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'share-telegram-')));
    store = new ShareStore(path.join(baseDir, 'shares.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  test('a freshly minted token never contains `_` and is byte-identical after formatting', () => {
    // Sample many mints — the property under test is probabilistic (the
    // generator must never emit `_`), not guaranteed by a single call.
    for (let i = 0; i < 200; i++) {
      const mint = store.mintShare({
        agentId: 'a1',
        sessionId: 's1',
        relativePath: `s1/ok-${i}.png`,
        dedupeRef: `path:s1/ok-${i}.png`,
        purpose: 'codex_ref',
        ttlSeconds: 1800,
      });
      expect(mint.token).not.toContain('_');

      const url = `https://pod-l0lpn8xy.vm.getpod.ai/gateway/shared/${mint.token}`;
      // The exact message shape DeliveryOutbox.enqueue hands to channelSender
      // for a share-file reply (see src/orchestration/delivery.ts:35), run
      // through the real, unmocked Telegram auto-format resolver.
      const outgoingText = `Here is your file: ${url}`;
      const { sendText } = resolveTelegramReplyFormat(outgoingText);

      expect(sendText).toContain(url);
      expect(sendText).toBe(outgoingText);
    }
  });

  test('reproduces the pre-fix corruption on a legacy `_`-containing token (documents the bug this fixes)', () => {
    // A token shaped like the pre-#532 base64url generator's output, with `_`
    // in exactly the positions the original bug report showed.
    const legacyUrl = 'https://pod-l0lpn8xy.vm.getpod.ai/gateway/shared/jDzEn1VTyGtjaXaHMC-h_wGRjRkkiQM_';
    const outgoingText = `Here is your file: ${legacyUrl}`;
    const { sendText } = resolveTelegramReplyFormat(outgoingText);

    // This is the corruption itself — kept as a documented, passing
    // assertion (not a `.skip`) so a future change to markdown.ts that
    // silently "fixes" this can't slip by unnoticed and invalidate the
    // reasoning behind generating `_`-free tokens in the first place.
    expect(sendText).not.toBe(outgoingText);
    expect(sendText).not.toContain(legacyUrl);
  });
});
