import * as fs from 'fs';
import os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { runCli } from '../../../src/cli';
import { SafemodeStore, atomicJson } from '../../../src/safemode/store';
import { runSafemode } from '../../../src/cli/commands/safemode';

describe('safemode CLI boundaries', () => {
  let home: string;
  let out: jest.SpyInstance;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-cli-')); jest.spyOn(os, 'homedir').mockReturnValue(home); out = jest.spyOn(process.stdout, 'write').mockReturnValue(true); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(home, {recursive:true,force:true}); });
  test('safemode help is a local CLI command', async () => {
    expect(await runCli(['safemode','--help'])).toBe(0);
    expect(out).toHaveBeenCalledWith(expect.stringContaining('native interactive Claude Code'));
  });
  test('rejects ambiguous gateway session flag and malformed values', async () => {
    await expect(runSafemode([], {session:'gateway-session'})).rejects.toThrow('Unknown safemode flag');
    await expect(runSafemode([], {model:true})).rejects.toThrow('requires a value');
  });
  test('native and outer resume conflict before stopping any owner', async () => {
    const input = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const output = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true});
    Object.defineProperty(process.stdout, 'isTTY', {value: true, configurable: true});
    const store = new SafemodeStore();
    const session = store.create('existing', 'codex', 'inherit');
    const owner = store.acquire(session.id, 'interactive');
    try {
      await expect(runSafemode([], {resume: 'existing', takeover: true, params: 'resume 11111111-2222-4333-8444-555555555555'})).rejects.toThrow('Do not combine');
      expect(store.owner(session.id)).toEqual(owner);
    } finally {
      if (input) Object.defineProperty(process.stdin, 'isTTY', input); else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (output) Object.defineProperty(process.stdout, 'isTTY', output); else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });
  test('headless CLI rejects params before any launch', async () => {
    await expect(runSafemode(['send', 'anything'], {params: '--dangerously-skip-permissions', prompt: 'inspect'})).rejects.toThrow('Unknown safemode flag');
  });
  test('rename CLI accepts current name or native ID and validates arity', async () => {
    const store = new SafemodeStore();
    const session = store.create('before', 'claude', 'inherit');
    expect(await runSafemode(['rename', session.id, 'after'], {})).toBe(0);
    expect(store.find('after').id).toBe(session.id);
    expect(out).toHaveBeenCalledWith(expect.stringContaining('"renamed": true'));
    await expect(runSafemode(['rename', session.id], {})).rejects.toThrow('requires');
  });
  test('duplicate request with takeover does not stop its running owner', async () => {
    const store = new SafemodeStore();
    const session = store.create('test','claude','inherit');
    const owner = store.acquire(session.id,'headless');
    fs.mkdirSync(path.join(store.dir(session.id),'requests'));
    atomicJson(path.join(store.dir(session.id),'requests','once.json'), {id:'once',status:'running',promptHash:createHash('sha256').update(JSON.stringify(['inspect','claude','inherit'])).digest('hex')});
    expect(await runSafemode(['send','test'], {prompt:'inspect','request-id':'once',takeover:true})).toBe(0);
    expect(store.owner(session.id)).toEqual(owner);
    expect(out).toHaveBeenCalledWith(expect.stringContaining('"duplicate": true'));
    await expect(runSafemode(['send','test'], {prompt:'new','request-id':'twice',takeover:true})).rejects.toThrow('headless request is already running');
  });
});
