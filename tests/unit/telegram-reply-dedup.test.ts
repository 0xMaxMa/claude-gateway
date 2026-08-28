/**
 * Regression tests for the telegram_reply turn-scoped dedup gate.
 *
 * Root cause: handleReply() had no gate before calling sendMessage — if the
 * model called telegram_reply multiple times in one turn (e.g. re-announcing
 * the same result), every call hit the real Telegram API. This mirrors the
 * turnId already written into the `.replied` marker (shared with typing.ts's
 * auto-forward dedup) but never checked by handleReply() itself.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TelegramModule } from '../../mcp/tools/telegram/module';
import { normalizeTelegramLineBreaks, resolveTelegramReplyFormat } from '../../mcp/tools/telegram/pure';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgdedup-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freshModule(stateDir: string): { mod: any; sendMessage: jest.Mock } {
  process.env.TELEGRAM_STATE_DIR = stateDir;
  const mod: any = new TelegramModule();
  const sendMessage = jest.fn(async () => ({ message_id: Math.floor(Math.random() * 100000) }));
  mod.bot = { api: { sendMessage } };
  mod._normalizeTelegramLineBreaks = normalizeTelegramLineBreaks;
  mod._resolveTelegramReplyFormat = resolveTelegramReplyFormat;

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'access.json'),
    JSON.stringify({
      dmPolicy: 'allowlist',
      pairing: false,
      allowFrom: ['c1', 'c2'],
      groupPolicy: 'allowlist',
      groupAllowlist: [],
      requireMention: true,
      pending: {},
    }),
  );
  return { mod, sendMessage };
}

function setTurn(stateDir: string, chatId: string, turnId: string | null): void {
  const typingDir = path.join(stateDir, 'typing');
  fs.mkdirSync(typingDir, { recursive: true });
  if (turnId === null) {
    fs.rmSync(path.join(typingDir, chatId), { force: true });
  } else {
    fs.writeFileSync(path.join(typingDir, chatId), turnId);
  }
}

describe('telegram_reply turn-scoped dedup gate', () => {
  it('TD1: a second reply in the SAME turn is blocked before hitting the Telegram API', async () => {
    const { mod, sendMessage } = freshModule(tmp);
    setTurn(tmp, 'c1', '1000');

    const r1 = await mod.handleReply({ chat_id: 'c1', text: 'done!' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(r1.content[0].text).toMatch(/^sent/);

    // Agent re-announces the same result, reworded — must be blocked, not sent.
    await expect(
      mod.handleReply({ chat_id: 'c1', text: 'done again! (reworded)' }),
    ).rejects.toThrow(/already sent a message this turn/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('TD2: allow_multiple:true permits a second reply in the same turn', async () => {
    const { mod, sendMessage } = freshModule(tmp);
    setTurn(tmp, 'c1', '1000');

    await mod.handleReply({ chat_id: 'c1', text: 'here is an image' });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const r2 = await mod.handleReply({
      chat_id: 'c1',
      text: 'and some context',
      allow_multiple: true,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(r2.content[0].text).toMatch(/^sent/);
  });

  it('TD3: a reply in a NEW turn (turn signal changed) is allowed again', async () => {
    const { mod, sendMessage } = freshModule(tmp);
    setTurn(tmp, 'c1', '1000');
    await mod.handleReply({ chat_id: 'c1', text: 'turn 1 result' });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    setTurn(tmp, 'c1', '2000'); // a new turn started
    const r2 = await mod.handleReply({ chat_id: 'c1', text: 'turn 2 result' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(r2.content[0].text).toMatch(/^sent/);
  });

  it('TD4: no active turn signal (turnId null, e.g. an autonomous reply) is never blocked', async () => {
    const { mod, sendMessage } = freshModule(tmp);
    setTurn(tmp, 'c1', null); // no live typing-signal file

    await mod.handleReply({ chat_id: 'c1', text: 'first' });
    await mod.handleReply({ chat_id: 'c1', text: 'second' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('TD5: a FAILED first send does not block the retry (mark-after-success)', async () => {
    const { mod, sendMessage } = freshModule(tmp);
    setTurn(tmp, 'c1', '1000');
    sendMessage.mockRejectedValueOnce(new Error('transient telegram failure'));

    await expect(mod.handleReply({ chat_id: 'c1', text: 'hello' })).rejects.toThrow(/reply failed/);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    const r2 = await mod.handleReply({ chat_id: 'c1', text: 'hello retry' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(r2.content[0].text).toMatch(/^sent/);
  });

  it('TD6: dedup is per-chat — a different chat in the same turn is not blocked', async () => {
    const { mod, sendMessage } = freshModule(tmp);
    setTurn(tmp, 'c1', '1000');
    setTurn(tmp, 'c2', '1000');

    await mod.handleReply({ chat_id: 'c1', text: 'for chat 1' });
    const r2 = await mod.handleReply({ chat_id: 'c2', text: 'for chat 2' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(r2.content[0].text).toMatch(/^sent/);
  });
});
