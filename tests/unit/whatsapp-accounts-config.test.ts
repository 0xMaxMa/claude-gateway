/**
 * Unit tests for the WhatsApp multi-account config layer
 * (src/config/whatsapp-accounts.ts) — Phase 1 of the WhatsApp feature-parity
 * plan, where `AgentConfig.whatsapp` went from ONE flat block to
 * `{ accounts: [...] }`.
 *
 * The riskiest part of that change is a gateway upgraded IN PLACE: its
 * config.json is in the old shape and its `.whatsapp-state/` holds a LIVE
 * linked session. So the two invariants under test are:
 *   1. an old config is upgraded, in memory AND written back to disk, and
 *   2. the synthesized account is 'default', whose state directory is still
 *      the historical BARE `.whatsapp-state/` — nothing on disk moves.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_WHATSAPP_ACCOUNT_ID,
  WHATSAPP_ACCOUNT_ID_RE,
  findWhatsAppAccount,
  isLegacyWhatsAppBlock,
  resolveWhatsAppAccounts,
  upgradeAgentWhatsAppAccounts,
  upgradeWhatsAppAccountsFile,
  upgradeWhatsAppAccountsInConfig,
  whatsAppStateDir,
} from '../../src/config/whatsapp-accounts';
import { loadConfig } from '../../src/config/loader';

const LEGACY_AGENT = {
  id: 'alfred',
  workspace: '/tmp/alfred',
  whatsapp: {
    dmPolicy: 'allowlist',
    dmAllowlist: ['66812345678@s.whatsapp.net'],
    groupPolicy: 'open',
    requireMention: false,
    pairing: false,
  },
};

describe('whatsAppStateDir', () => {
  it("keeps 'default' on the bare .whatsapp-state path so a live session never moves", () => {
    expect(whatsAppStateDir('/ws', DEFAULT_WHATSAPP_ACCOUNT_ID)).toBe('/ws/.whatsapp-state');
  });

  it('nests every other account one level below it', () => {
    expect(whatsAppStateDir('/ws', 'work')).toBe('/ws/.whatsapp-state/work');
  });
});

describe('WHATSAPP_ACCOUNT_ID_RE', () => {
  it('accepts slugs and rejects anything that could escape or hide a directory', () => {
    for (const ok of ['default', 'work', 'a', 'my-2nd_number', '0']) {
      expect(WHATSAPP_ACCOUNT_ID_RE.test(ok)).toBe(true);
    }
    for (const bad of ['', '..', '../escape', 'a/b', '.hidden', 'Work', 'has space', '-lead', 'x'.repeat(33)]) {
      expect(WHATSAPP_ACCOUNT_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe('resolveWhatsAppAccounts', () => {
  it("synthesizes a lone 'default' when there is no whatsapp config at all", () => {
    // Matches the pre-multi-account behavior, where a manager was constructed
    // unconditionally: an agent that never configured WhatsApp is still linkable.
    expect(resolveWhatsAppAccounts(undefined)).toEqual([{ id: 'default' }]);
    expect(resolveWhatsAppAccounts({ accounts: [] })).toEqual([{ id: 'default' }]);
  });

  it('returns configured accounts verbatim, and findWhatsAppAccount picks one out', () => {
    const cfg = { accounts: [{ id: 'default' }, { id: 'work', dmPolicy: 'open' as const }] };
    expect(resolveWhatsAppAccounts(cfg)).toBe(cfg.accounts);
    expect(findWhatsAppAccount(cfg, 'work')?.dmPolicy).toBe('open');
    expect(findWhatsAppAccount(cfg, 'ghost')).toBeUndefined();
  });
});

describe('legacy upgrade', () => {
  it('detects the old flat shape (including an empty block) and not the new one', () => {
    expect(isLegacyWhatsAppBlock({ dmPolicy: 'open' })).toBe(true);
    expect(isLegacyWhatsAppBlock({})).toBe(true);
    expect(isLegacyWhatsAppBlock({ accounts: [] })).toBe(false);
    expect(isLegacyWhatsAppBlock(undefined)).toBe(false);
  });

  it("lifts every legacy access field onto a single 'default' account", () => {
    const agent = JSON.parse(JSON.stringify(LEGACY_AGENT));
    expect(upgradeAgentWhatsAppAccounts(agent)).toBe(true);
    expect(agent.whatsapp).toEqual({
      accounts: [
        {
          id: 'default',
          dmPolicy: 'allowlist',
          dmAllowlist: ['66812345678@s.whatsapp.net'],
          groupPolicy: 'open',
          requireMention: false,
          pairing: false,
        },
      ],
    });
  });

  it('omits fields the old block never had, rather than materializing undefineds', () => {
    const agent: Record<string, unknown> = { id: 'a', whatsapp: { pairing: false } };
    upgradeAgentWhatsAppAccounts(agent);
    expect(agent.whatsapp).toEqual({ accounts: [{ id: 'default', pairing: false }] });
  });

  it('is idempotent — a second pass reports no change and rewrites nothing', () => {
    const agent = JSON.parse(JSON.stringify(LEGACY_AGENT));
    upgradeAgentWhatsAppAccounts(agent);
    const after = JSON.parse(JSON.stringify(agent.whatsapp));
    expect(upgradeAgentWhatsAppAccounts(agent)).toBe(false);
    expect(agent.whatsapp).toEqual(after);
  });

  it('leaves an agent with no whatsapp block alone', () => {
    const agent: Record<string, unknown> = { id: 'a' };
    expect(upgradeAgentWhatsAppAccounts(agent)).toBe(false);
    expect(agent.whatsapp).toBeUndefined();
  });

  it('reports the ids of upgraded agents and skips already-migrated ones', () => {
    const config = {
      agents: [
        JSON.parse(JSON.stringify(LEGACY_AGENT)),
        { id: 'nochannel' },
        { id: 'already', whatsapp: { accounts: [{ id: 'work' }] } },
      ],
    };
    expect(upgradeWhatsAppAccountsInConfig(config)).toEqual(['alfred']);
  });
});

describe('upgradeWhatsAppAccountsFile — self-healing write-back', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-wa-accounts-'));
    configPath = path.join(tmpDir, 'config.json');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const write = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('rewrites an old config in place so the migration is permanent', () => {
    write({ gateway: { logDir: '~/logs' }, agents: [JSON.parse(JSON.stringify(LEGACY_AGENT))] });
    expect(upgradeWhatsAppAccountsFile(configPath)).toEqual(['alfred']);

    const onDisk = read();
    expect(onDisk.agents[0].whatsapp.accounts[0]).toMatchObject({ id: 'default', dmPolicy: 'allowlist' });
    // Everything else in the file survives the rewrite untouched.
    expect(onDisk.gateway).toEqual({ logDir: '~/logs' });
    expect(onDisk.agents[0].workspace).toBe('/tmp/alfred');
    // And a second boot is a no-op — no rewrite, no churn.
    expect(upgradeWhatsAppAccountsFile(configPath)).toEqual([]);
  });

  it('leaves no temp file behind', () => {
    write({ gateway: {}, agents: [JSON.parse(JSON.stringify(LEGACY_AGENT))] });
    upgradeWhatsAppAccountsFile(configPath);
    expect(fs.readdirSync(tmpDir)).toEqual(['config.json']);
  });

  it('is best-effort: a missing or unparseable config is reported as nothing upgraded', () => {
    // loadConfig produces the real user-facing error for these; boot must not
    // die inside the migration helper first.
    expect(upgradeWhatsAppAccountsFile(path.join(tmpDir, 'nope.json'))).toEqual([]);
    fs.writeFileSync(configPath, '{ not json');
    expect(upgradeWhatsAppAccountsFile(configPath)).toEqual([]);
  });

  it('normalizes in memory too, so runtime is right even when the write-back could not happen', () => {
    // Simulates a read-only config volume: loadConfig alone must still hand
    // the rest of the gateway the new shape.
    write({
      gateway: { logDir: '~/logs', timezone: 'UTC' },
      agents: [JSON.parse(JSON.stringify(LEGACY_AGENT))],
    });
    const loaded = loadConfig(configPath);
    expect(loaded.agents[0].whatsapp).toEqual({
      accounts: [
        {
          id: 'default',
          dmPolicy: 'allowlist',
          dmAllowlist: ['66812345678@s.whatsapp.net'],
          groupPolicy: 'open',
          requireMention: false,
          pairing: false,
        },
      ],
    });
    // loadConfig does not write — the file is still the legacy shape.
    expect(read().agents[0].whatsapp).toEqual(LEGACY_AGENT.whatsapp);
  });
});
