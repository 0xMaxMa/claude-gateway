import express from 'express';
import request from 'supertest';
import { ProcessCapacity } from '../../src/orchestration/capacity';
import { changedConfigPaths, reloadMode, setConfigValue } from '../../src/config/reload-policy';
import { createApiAuthMiddleware } from '../../src/api/auth';
import { DreamingManager } from '../../src/agent/dreaming';
import type { ApiKey } from '../../src/types';

test('lower capacity preserves admitted work and admits again after leases drain', () => {
  const c = new ProcessCapacity(5, 1);
  const leases = [c.acquire('worker')!, c.acquire('worker')!, c.acquire('worker')!];
  c.configure(2, 1); expect(c.count).toBe(3); expect(c.acquire('agent')).toBeUndefined(); expect(c.acquire('worker')).toBeUndefined();
  leases[0](); leases[1](); expect(c.count).toBe(1); expect(c.acquire('worker')).toBeUndefined();
  const agent = c.acquire('agent'); expect(agent).toBeDefined(); agent!(); leases[2](); expect(c.count).toBe(0);
  expect(() => c.configure(1, 2)).toThrow(); expect(c.total).toBe(2);
});

test('adding a nested block does not hide cold storage paths behind its live parent', () => {
  const paths = changedConfigPaths({}, { gateway: { knowledge: { archive: { enabled: true, tokenizer: 'new' }, shared: { root: '/new' } } } });
  expect(paths).toContain('gateway.knowledge.archive.enabled');
  expect(reloadMode('', 'gateway.knowledge.archive.enabled')).toBe('component');
  expect(reloadMode('', 'gateway.knowledge.archive.tokenizer')).toBe('restart');
  expect(reloadMode('', 'gateway.knowledge.shared.root')).toBe('restart');
  expect(reloadMode('', 'gateway.futureSetting')).toBe('restart');
  expect(() => setConfigValue({}, '__proto__.polluted', true)).toThrow();
  expect(({} as any).polluted).toBeUndefined();
});

test('mounted auth starts closed with no keys and observes additions and revocations', async () => {
  const keys: ApiKey[] = [];
  const app = express(); app.use(createApiAuthMiddleware(keys)); app.get('/check', (_q, r) => r.json({ ok: true }));
  expect((await request(app).get('/check')).status).toBe(401);
  keys.push({ key: 'first', agents: '*', admin: true });
  expect((await request(app).get('/check').set('x-api-key', 'first')).status).toBe(200);
  keys.splice(0, keys.length, { key: 'second', agents: '*', admin: true });
  expect((await request(app).get('/check').set('x-api-key', 'first')).status).toBe(403);
  expect((await request(app).get('/check').set('x-api-key', 'second')).status).toBe(200);
  keys.splice(0); expect((await request(app).get('/check').set('x-api-key', 'second')).status).toBe(403);
});

test('dreaming enable/disable reschedules without accumulating timers', () => {
  jest.useFakeTimers();
  const deps = { db: { listSessions: () => [], getSessionTranscript: () => [] }, agentId: 'fixture', workspaceDir: '/tmp', globalCfg: { enabled: false } };
  const manager = new DreamingManager(deps);
  try {
    manager.startDreaming(); expect(jest.getTimerCount()).toBe(0);
    manager.reconfigure({ ...deps, globalCfg: { enabled: true } }); expect(jest.getTimerCount()).toBe(1);
    manager.reconfigure({ ...deps, globalCfg: { enabled: true }, gatewayTimezone: 'Asia/Bangkok' }); expect(jest.getTimerCount()).toBe(1);
    manager.reconfigure(deps); expect(jest.getTimerCount()).toBe(0);
  } finally { manager.stop(); jest.useRealTimers(); }
});
