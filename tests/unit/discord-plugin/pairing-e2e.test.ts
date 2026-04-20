/**
 * Integration-style tests for Discord pairing flow using real filesystem operations.
 * Tests the full flow: DM arrives → code generated → pair command → approved file created.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  gate,
  loadAccess,
  saveAccess,
  defaultAccess,
} from '../../../mcp/tools/discord/access';
import type { DiscordMessageContext } from '../../../mcp/tools/discord/types';

const dmContext: DiscordMessageContext = {
  guildId: null,
  channelId: 'dm-channel-abc',
  threadId: null,
  userId: 'user-xyz',
  username: 'tester',
  messageId: 'msg-1',
  isDM: true,
  isThread: false,
};

describe('Discord pairing integration', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-pairing-'));
    const access = { ...defaultAccess(), dmPolicy: 'pairing' as const };
    saveAccess(stateDir, access);
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('PE1: DM from unknown user generates pairing code and saves pending', () => {
    const access = loadAccess(stateDir);
    let savedAccess = access;
    const result = gate(
      access,
      dmContext,
      (a) => { savedAccess = { ...a, pending: { ...a.pending } }; saveAccess(stateDir, a); },
      () => 'testcd',
    );

    expect(result.action).toBe('pair');
    if (result.action === 'pair') {
      expect(result.code).toBe('testcd');
      expect(result.isResend).toBe(false);
    }

    // Verify pending entry in file
    const onDisk = loadAccess(stateDir);
    expect(onDisk.pending['testcd']).toBeDefined();
    expect(onDisk.pending['testcd'].senderId).toBe('user-xyz');
    expect(onDisk.pending['testcd'].channelId).toBe('dm-channel-abc');
  });

  it('PE2: approve pairing code → approved file created, user in allowFrom', () => {
    // Setup: create pending code
    const access = loadAccess(stateDir);
    gate(access, dmContext, (a) => saveAccess(stateDir, a), () => 'code99');

    // Simulate /discord:access pair code99 (what pair.ts does)
    const onDisk = loadAccess(stateDir);
    const entry = onDisk.pending['code99'];
    expect(entry).toBeDefined();

    // Add to allowFrom
    onDisk.allowFrom.push(entry.senderId);
    delete onDisk.pending['code99'];
    saveAccess(stateDir, onDisk);

    // Write approved file (what pair.ts does)
    const approvedDir = path.join(stateDir, 'approved');
    fs.mkdirSync(approvedDir, { recursive: true });
    fs.writeFileSync(path.join(approvedDir, entry.senderId), entry.channelId);

    // Verify results
    const final = loadAccess(stateDir);
    expect(final.allowFrom).toContain('user-xyz');
    expect(final.pending['code99']).toBeUndefined();

    const approvedFile = path.join(approvedDir, 'user-xyz');
    expect(fs.existsSync(approvedFile)).toBe(true);
    expect(fs.readFileSync(approvedFile, 'utf8')).toBe('dm-channel-abc');
  });

  it('PE3: using expired code → gate() drops it (expired)', () => {
    const past = Date.now() - 1000;
    const access = loadAccess(stateDir);
    access.pending['old-code'] = {
      senderId: 'user-xyz',
      channelId: 'dm-channel-abc',
      createdAt: past - 3600_000,
      expiresAt: past,
      replies: 1,
    };
    saveAccess(stateDir, access);

    // Trying to pair with expired code — gate prunes it, user gets new code
    const fresh = loadAccess(stateDir);
    const result = gate(fresh, dmContext, (a) => saveAccess(stateDir, a), () => 'newcode');
    expect(result.action).toBe('pair');
    if (result.action === 'pair') {
      expect(result.code).toBe('newcode');
      expect(result.isResend).toBe(false);
    }

    const onDisk = loadAccess(stateDir);
    expect(onDisk.pending['old-code']).toBeUndefined();
    expect(onDisk.pending['newcode']).toBeDefined();
  });

  it('PE4: after pairing, user can deliver messages', () => {
    // Pair the user
    const access = loadAccess(stateDir);
    access.allowFrom = ['user-xyz'];
    saveAccess(stateDir, access);

    // Now gate should deliver
    const fresh = loadAccess(stateDir);
    const result = gate(fresh, dmContext, () => {}, () => 'x');
    expect(result.action).toBe('deliver');
  });
});
