import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SkillNotifier,
  readTelegramRecipients,
  readDiscordRecipients,
  readLineRecipients,
  buildTelegramSend,
  buildDiscordSend,
  buildLineSend,
  buildChannelSend,
  DIARY_FILENAME,
  NOTIFY_THROTTLE_MAX,
  NOTIFY_THROTTLE_WINDOW_MS,
  type SkillWriteEvent,
} from '../../../src/agent/skill-learning/notifier';

function ev(overrides: Partial<SkillWriteEvent> = {}): SkillWriteEvent {
  return { name: 'my-skill', action: 'create', sessionId: 'abcdef1234567890', now: 1_000, ...overrides };
}

describe('SkillNotifier', () => {
  let ws: string;
  let sent: string[];

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-notify-'));
    sent = [];
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const diary = () => fs.readFileSync(path.join(ws, DIARY_FILENAME), 'utf-8');
  const capture = (text: string) => { sent.push(text); };

  describe('diary (always-on)', () => {
    it('creates the diary with a header on the first write, then appends without re-heading', () => {
      const n = new SkillNotifier({ workspaceDir: ws, notify: false });
      n.onSkillWritten(ev({ name: 'first', action: 'create' }));
      n.onSkillWritten(ev({ name: 'second', action: 'edit' }));

      const body = diary();
      expect(body).toContain('# Skills Learned (auto)');
      expect(body.match(/# Skills Learned/g)).toHaveLength(1); // header once
      expect(body).toContain('**create** `first`');
      expect(body).toContain('**edit** `second`');
    });

    it('writes the diary even when channel push is disabled', () => {
      const n = new SkillNotifier({ workspaceDir: ws, notify: false, send: capture });
      n.onSkillWritten(ev());
      expect(fs.existsSync(path.join(ws, DIARY_FILENAME))).toBe(true);
      expect(sent).toHaveLength(0); // notify:false ⇒ no channel push
    });
  });

  describe('channel push + throttle', () => {
    it('pings immediately for each write up to the burst cap', () => {
      const n = new SkillNotifier({ workspaceDir: ws, notify: true, send: capture });
      for (let i = 0; i < NOTIFY_THROTTLE_MAX; i++) {
        n.onSkillWritten(ev({ name: `skill-${i}`, now: 1_000 + i }));
      }
      expect(sent).toHaveLength(NOTIFY_THROTTLE_MAX);
      expect(sent[0]).toContain('skill-0');
      expect(sent[0]).toContain('created');
    });

    it('coalesces writes beyond the cap into one digest on flush', () => {
      const n = new SkillNotifier({ workspaceDir: ws, notify: true, send: capture });
      const total = NOTIFY_THROTTLE_MAX + 3;
      for (let i = 0; i < total; i++) {
        n.onSkillWritten(ev({ name: `skill-${i}`, action: i % 2 ? 'edit' : 'create', now: 1_000 + i }));
      }
      // Only the first MAX went out immediately; the rest are buffered.
      expect(sent).toHaveLength(NOTIFY_THROTTLE_MAX);

      n.flushPending();
      expect(sent).toHaveLength(NOTIFY_THROTTLE_MAX + 1); // one digest
      const digest = sent[sent.length - 1];
      expect(digest).toContain('3 more skills learned');
      expect(digest).toContain('skill-3');
    });

    it('re-arms immediate pings after the window rolls forward', () => {
      const n = new SkillNotifier({ workspaceDir: ws, notify: true, send: capture });
      for (let i = 0; i < NOTIFY_THROTTLE_MAX; i++) n.onSkillWritten(ev({ now: 1_000 + i }));
      expect(sent).toHaveLength(NOTIFY_THROTTLE_MAX);

      // A write past the window edge should ping immediately again.
      n.onSkillWritten(ev({ name: 'after-window', now: 1_000 + NOTIFY_THROTTLE_WINDOW_MS + 1 }));
      expect(sent).toHaveLength(NOTIFY_THROTTLE_MAX + 1);
      expect(sent[sent.length - 1]).toContain('after-window');
    });

    it('never throws when the transport rejects, and still writes the diary', () => {
      const throwing = () => { throw new Error('network down'); };
      const n = new SkillNotifier({ workspaceDir: ws, notify: true, send: throwing });
      expect(() => n.onSkillWritten(ev())).not.toThrow();
      expect(fs.existsSync(path.join(ws, DIARY_FILENAME))).toBe(true);
    });

    it('is diary-only when no transport is wired', () => {
      const n = new SkillNotifier({ workspaceDir: ws, notify: true /* no send */ });
      expect(() => n.onSkillWritten(ev())).not.toThrow();
      expect(fs.existsSync(path.join(ws, DIARY_FILENAME))).toBe(true);
    });
  });
});

describe('readTelegramRecipients', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-recip-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('returns allowFrom chat_ids from access.json', () => {
    const stateDir = path.join(ws, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify({ allowFrom: ['997170033', '42'] }));
    expect(readTelegramRecipients(ws)).toEqual(['997170033', '42']);
  });

  it('returns [] when the file is missing or malformed', () => {
    expect(readTelegramRecipients(ws)).toEqual([]);
    const stateDir = path.join(ws, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'access.json'), 'not json');
    expect(readTelegramRecipients(ws)).toEqual([]);
  });

  it('filters non-string entries', () => {
    const stateDir = path.join(ws, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify({ allowFrom: ['ok', 123, null, ''] }));
    expect(readTelegramRecipients(ws)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// Multi-channel transport registry
// ---------------------------------------------------------------------------

function writeAccess(ws: string, stateDir: string, allowFrom: string[]): void {
  const dir = path.join(ws, stateDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify({ allowFrom }));
}

/** Minimal ok/json fetch Response stub. */
function fetchOk(json: unknown = {}): Response {
  return { ok: true, status: 200, json: async () => json, text: async () => '' } as unknown as Response;
}

describe('per-channel recipient resolution', () => {
  let ws: string;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-chan-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); });

  it('reads Discord recipients from .discord-state/access.json', () => {
    writeAccess(ws, '.discord-state', ['111', '222']);
    expect(readDiscordRecipients(ws)).toEqual(['111', '222']);
  });

  it('reads LINE recipients from .line-state/access.json', () => {
    writeAccess(ws, '.line-state', ['Uabc']);
    expect(readLineRecipients(ws)).toEqual(['Uabc']);
  });

  it('returns [] when a channel has no state dir', () => {
    expect(readDiscordRecipients(ws)).toEqual([]);
    expect(readLineRecipients(ws)).toEqual([]);
  });
});

describe('buildDiscordSend', () => {
  let ws: string;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-dc-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); fetchMock?.mockRestore(); });

  it('returns undefined without a bot token (dormant)', () => {
    expect(buildDiscordSend(ws, undefined)).toBeUndefined();
  });

  it('opens a DM channel per recipient, then posts the message to that channel', async () => {
    writeAccess(ws, '.discord-state', ['user-1']);
    const calls: Array<{ url: string; body: unknown }> = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : undefined });
      if (u.endsWith('/users/@me/channels')) return fetchOk({ id: 'dm-chan-99' });
      return fetchOk();
    });

    const send = buildDiscordSend(ws, 'bot-token')!;
    await send('hello discord');

    // 1) open DM channel with the user id, 2) POST to the returned channel id.
    expect(calls[0].url).toContain('/users/@me/channels');
    expect(calls[0].body).toEqual({ recipient_id: 'user-1' });
    expect(calls[1].url).toContain('/channels/dm-chan-99/messages');
    expect(calls[1].body).toEqual({ content: 'hello discord' });
  });

  it('does not post when the DM channel cannot be opened', async () => {
    writeAccess(ws, '.discord-state', ['user-1']);
    const posted: string[] = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/users/@me/channels')) return { ok: false, status: 403, text: async () => 'no' } as unknown as Response;
      posted.push(u);
      return fetchOk();
    });

    const send = buildDiscordSend(ws, 'bot-token')!;
    await send('x');
    expect(posted).toHaveLength(0); // never reached the messages endpoint
  });
});

describe('buildLineSend', () => {
  let ws: string;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-line-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); fetchMock?.mockRestore(); });

  it('returns undefined without an access token (dormant until opened)', () => {
    expect(buildLineSend(ws, undefined)).toBeUndefined();
  });

  it('pushes a text message to each recipient via the LINE push API', async () => {
    writeAccess(ws, '.line-state', ['Uxyz']);
    const calls: Array<{ url: string; auth: string; body: any }> = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      calls.push({ url: String(url), auth: init?.headers?.Authorization, body: JSON.parse(init.body) });
      return fetchOk();
    });

    const send = buildLineSend(ws, 'line-tok')!;
    await send('hello line');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v2/bot/message/push');
    expect(calls[0].auth).toBe('Bearer line-tok');
    expect(calls[0].body).toEqual({ to: 'Uxyz', messages: [{ type: 'text', text: 'hello line' }] });
  });
});

describe('buildChannelSend (fan-out registry)', () => {
  let ws: string;
  let fetchMock: jest.SpyInstance;
  beforeEach(() => { ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fanout-')); });
  afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); fetchMock?.mockRestore(); });

  it('is undefined when no channel token is configured (diary-only)', () => {
    expect(buildChannelSend(ws, {})).toBeUndefined();
  });

  it('fans a single message out to every configured channel', async () => {
    writeAccess(ws, '.telegram-state', ['tg-1']);
    writeAccess(ws, '.discord-state', ['dc-1']);
    const hosts: string[] = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      hosts.push(new URL(u).host);
      if (u.endsWith('/users/@me/channels')) return fetchOk({ id: 'dm-1' });
      return fetchOk();
    });

    const send = buildChannelSend(ws, { telegramBotToken: 'tg', discordBotToken: 'dc' })!;
    await send('fan out');

    expect(hosts).toContain('api.telegram.org');
    expect(hosts).toContain('discord.com');
  });

  it('logs an HTTP error (401) instead of failing silently, and never throws', async () => {
    writeAccess(ws, '.telegram-state', ['tg-1']);
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string) => warns.push(m) };
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(
      async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }) as unknown as Response,
    );

    const send = buildTelegramSend(ws, 'stale-token', logger)!;
    await expect(send('x')).resolves.toBeUndefined(); // best-effort, no throw
    expect(warns.some((w) => w.includes('401'))).toBe(true); // status surfaced
  });

  it('one channel failing never blocks the others', async () => {
    writeAccess(ws, '.telegram-state', ['tg-1']);
    writeAccess(ws, '.discord-state', ['dc-1']);
    const reached: string[] = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) throw new Error('telegram down');
      reached.push(new URL(u).host);
      if (u.endsWith('/users/@me/channels')) return fetchOk({ id: 'dm-1' });
      return fetchOk();
    });

    const send = buildChannelSend(ws, { telegramBotToken: 'tg', discordBotToken: 'dc' })!;
    await expect(send('x')).resolves.toBeUndefined(); // never rejects
    expect(reached).toContain('discord.com'); // discord still delivered
  });
});
