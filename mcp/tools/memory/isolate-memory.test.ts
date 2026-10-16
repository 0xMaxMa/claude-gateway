/**
 * Bun tests for isolated memory mode (#601). The knowledge archive is one
 * index per agent with no conversation column, so any session's memory_search can
 * return a note written for another sender. Isolate mode turns the module off.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MemoryModule } from './module';
import { SkillsModule } from '../skills/module';
import { CronModule } from '../cron/module';
import { AgentModule } from '../agent/module';
import { AppsModule } from '../apps/module';
import { archiveDbPath } from './archive-reader';

let agentDir: string;
const originalEnv = {
  GATEWAY_WORKSPACE_DIR: process.env.GATEWAY_WORKSPACE_DIR,
  GATEWAY_SHARED_KB_DIR: process.env.GATEWAY_SHARED_KB_DIR,
  GATEWAY_ISOLATE_MEMORY: process.env.GATEWAY_ISOLATE_MEMORY,
  GATEWAY_API_URL: process.env.GATEWAY_API_URL,
  GATEWAY_AGENT_ID: process.env.GATEWAY_AGENT_ID,
};

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-iso-'));
  const workspaceDir = path.join(agentDir, 'workspace');
  fs.mkdirSync(workspaceDir);
  // Same schema src/ writes; one chunk recorded while serving conversation A.
  const db = new Database(archiveDbPath(workspaceDir));
  db.exec(`
    CREATE TABLE kb_chunks (rowid_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, path TEXT,
      start_line INTEGER, end_line INTEGER, text TEXT, updated_at INTEGER);
    CREATE TABLE kb_chunk_recall (chunk_id TEXT PRIMARY KEY, importance INTEGER, triggers TEXT, project_key TEXT);
    CREATE TABLE kb_chunk_provenance (chunk_id TEXT PRIMARY KEY, origin_class TEXT, session_kind TEXT,
      observed_at INTEGER, supersedes_key TEXT);
    CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(text, content='kb_chunks', content_rowid='rowid_id');
    CREATE TRIGGER kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
      INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.rowid_id, new.text);
    END;
  `);
  db.prepare('INSERT INTO kb_chunks(id,path,start_line,end_line,text,updated_at) VALUES(?,?,?,?,?,?)')
    .run('c1', 'memory/chat-a.md', 1, 1, 'Chat A bank account ends 4321', 1);
  db.close();
  process.env.GATEWAY_WORKSPACE_DIR = workspaceDir;
  delete process.env.GATEWAY_SHARED_KB_DIR;
  delete process.env.GATEWAY_ISOLATE_MEMORY;
});

afterEach(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('without isolate mode, any session can search a note written for another sender', async () => {
  const mod = new MemoryModule();
  expect(mod.isEnabled()).toBe(true);
  const result = await mod.handleTool('memory_search', { query: 'bank account' });
  expect((result.content[0] as { text: string }).text).toContain('4321');
});

test('isolate mode turns the memory module off, so its tools are never registered', () => {
  process.env.GATEWAY_ISOLATE_MEMORY = '1';
  expect(new MemoryModule().isEnabled()).toBe(false);
});

test('isolate mode turns the skills module off: the skill catalog is shared by every conversation', () => {
  expect(new SkillsModule().isEnabled()).toBe(true);
  process.env.GATEWAY_ISOLATE_MEMORY = '1';
  expect(new SkillsModule().isEnabled()).toBe(false);
});

test('isolate mode turns the cron and agent modules off: jobs and the persona are shared by every conversation', () => {
  process.env.GATEWAY_API_URL = 'http://127.0.0.1:1';
  process.env.GATEWAY_AGENT_ID = 'shared-bot';
  expect(new CronModule().isEnabled()).toBe(true);
  expect(new AgentModule().isEnabled()).toBe(true);
  process.env.GATEWAY_ISOLATE_MEMORY = '1';
  expect(new CronModule().isEnabled()).toBe(false);
  expect(new AgentModule().isEnabled()).toBe(false);
});

test('isolate mode turns the apps module off: restoring or uninstalling an app rewinds every conversation\'s memory', () => {
  process.env.GATEWAY_API_URL = 'http://127.0.0.1:1';
  expect(new AppsModule().isEnabled()).toBe(true);
  process.env.GATEWAY_ISOLATE_MEMORY = '1';
  expect(new AppsModule().isEnabled()).toBe(false);
});
