/**
 * Bun tests for disable_archive (#609): an agent that turns the archive off
 * is never offered memory_search/memory_get, independent of isolate mode.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';

import { MemoryModule } from './module';
import { SkillsModule } from '../skills/module';

const originalEnv = {
  GATEWAY_WORKSPACE_DIR: process.env.GATEWAY_WORKSPACE_DIR,
  GATEWAY_ISOLATE_MEMORY: process.env.GATEWAY_ISOLATE_MEMORY,
  GATEWAY_DISABLE_ARCHIVE: process.env.GATEWAY_DISABLE_ARCHIVE,
};

beforeEach(() => {
  process.env.GATEWAY_WORKSPACE_DIR = '/tmp/disable-archive-workspace';
  delete process.env.GATEWAY_ISOLATE_MEMORY;
  delete process.env.GATEWAY_DISABLE_ARCHIVE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('the memory module is offered when the archive is not disabled', () => {
  expect(new MemoryModule().isEnabled()).toBe(true);
});

test('GATEWAY_DISABLE_ARCHIVE turns the memory module off, so memory_search/memory_get are never registered', () => {
  process.env.GATEWAY_DISABLE_ARCHIVE = '1';
  expect(new MemoryModule().isEnabled()).toBe(false);
});

test('an empty GATEWAY_DISABLE_ARCHIVE (the forwarded value for an unset flag) keeps the module on', () => {
  process.env.GATEWAY_DISABLE_ARCHIVE = '';
  expect(new MemoryModule().isEnabled()).toBe(true);
});

test('disabling the archive does not imply isolate mode: other workspace modules stay on', () => {
  process.env.GATEWAY_DISABLE_ARCHIVE = '1';
  expect(new SkillsModule().isEnabled()).toBe(true);
});
