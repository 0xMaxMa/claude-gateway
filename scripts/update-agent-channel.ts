#!/usr/bin/env ts-node
/**
 * make update-agent-channel agent=<agentId>
 *
 * Interactive wizard to add, edit, or remove channels on an existing agent.
 * Channels: Telegram, Discord (Slack — coming soon).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentEntry {
  id: string;
  workspace: string;
  telegram?: { botToken: string; allowedUsers?: number[]; dmPolicy?: string };
  discord?: { botToken: string };
  [key: string]: unknown;
}

interface GatewayConfig {
  agents: AgentEntry[];
  [key: string]: unknown;
}

export type ChannelId = 'telegram' | 'discord';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function gatewayDir(): string {
  return path.join(os.homedir(), '.claude-gateway');
}

function configFilePath(): string {
  const env = process.env['GATEWAY_CONFIG'];
  if (env) return env.startsWith('~/') ? path.join(os.homedir(), env.slice(2)) : env;
  return path.join(gatewayDir(), 'config.json');
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function loadConfig(): GatewayConfig {
  const cp = configFilePath();
  try {
    return JSON.parse(fs.readFileSync(cp, 'utf8')) as GatewayConfig;
  } catch (err) {
    console.error(`Cannot read config at ${cp}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function saveConfig(config: GatewayConfig): void {
  const cp = configFilePath();
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(config, null, 2), 'utf8');
}

export function findAgent(config: GatewayConfig, agentId: string): AgentEntry | undefined {
  return config.agents.find(a => a.id === agentId);
}

// ---------------------------------------------------------------------------
// Channel detection
// ---------------------------------------------------------------------------

export function detectConnectedChannels(agent: AgentEntry): ChannelId[] {
  const connected: ChannelId[] = [];
  const workspace = expandHome(agent.workspace);

  if (agent.telegram?.botToken) {
    connected.push('telegram');
  } else {
    const stateEnv = path.join(workspace, '.telegram-state', '.env');
    if (fs.existsSync(stateEnv)) connected.push('telegram');
  }

  if (agent.discord?.botToken) {
    connected.push('discord');
  } else {
    const stateEnv = path.join(workspace, '.discord-state', '.env');
    if (fs.existsSync(stateEnv)) connected.push('discord');
  }

  return connected;
}

// ---------------------------------------------------------------------------
// Channel operations
// ---------------------------------------------------------------------------

export function removeChannel(
  config: GatewayConfig,
  agent: AgentEntry,
  channel: ChannelId,
): void {
  const workspace = expandHome(agent.workspace);
  const stateDir = path.join(workspace, `.${channel}-state`);

  // Remove state directory
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {}

  // Remove env var line from agentDir/.env
  const agentEnvFile = path.join(gatewayDir(), 'agents', agent.id, '.env');
  try {
    const lines = fs.readFileSync(agentEnvFile, 'utf8').split('\n');
    const prefix = channel === 'telegram'
      ? agent.id.toUpperCase().replace(/-/g, '_') + '_BOT_TOKEN='
      : agent.id.toUpperCase().replace(/-/g, '_') + '_DISCORD_BOT_TOKEN=';
    const filtered = lines.filter(l => !l.startsWith(prefix));
    fs.writeFileSync(agentEnvFile, filtered.join('\n'), { mode: 0o600 });
  } catch {}

  // Remove channel field from config entry
  const idx = config.agents.findIndex(a => a.id === agent.id);
  if (idx >= 0) {
    delete config.agents[idx][channel];
  }

  saveConfig(config);
  console.log(`  ✓ ${capitalize(channel)} removed from agent "${agent.id}"`);
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Supported channels list
// ---------------------------------------------------------------------------

const CHANNELS = [
  { id: 'telegram' as ChannelId, label: 'Telegram', available: true },
  { id: 'discord' as ChannelId, label: 'Discord', available: true },
];

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

export async function runMenu(agentId: string): Promise<void> {
  const config = loadConfig();
  const agent = findAgent(config, agentId);

  if (!agent) {
    console.error(`Agent "${agentId}" not found in config`);
    console.error(`Available: ${config.agents.map(a => a.id).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const rl = createRl();

  while (true) {
    const connected = detectConnectedChannels(agent);
    const connectedLabels = connected.map(c => `${capitalize(c)} ✓`).join(', ') || '(none)';

    console.log('\n═══════════════════════════════════════');
    console.log(`  Agent: ${agent.id}  (connected: ${connectedLabels})`);
    console.log('═══════════════════════════════════════\n');
    console.log('  1) Add a channel');
    console.log('  2) Remove a channel');
    console.log('  3) Exit\n');

    const choice = (await ask(rl, 'Choose (1-3): ')).trim();

    if (choice === '3' || choice.toLowerCase() === 'exit') {
      console.log('Done.');
      rl.close();
      return;
    }

    if (choice === '1') {
      const available = CHANNELS.filter(c => !connected.includes(c.id));
      if (available.length === 0) {
        console.log('\n  All supported channels are already connected.');
        continue;
      }
      console.log('\nAvailable channels to add:');
      available.forEach((c, i) => console.log(`  ${i + 1}) ${c.label}`));
      const sel = (await ask(rl, 'Choose channel: ')).trim();
      const chIdx = parseInt(sel, 10) - 1;
      if (chIdx < 0 || chIdx >= available.length) {
        console.log('  Invalid choice.');
        continue;
      }
      const ch = available[chIdx];
      rl.close();
      console.log(`\nSetting up ${ch.label}...\n`);
      await setupChannel(agent, ch.id, config);
      return;
    }

    if (choice === '2') {
      if (connected.length === 0) {
        console.log('\n  No channels connected.');
        continue;
      }
      console.log('\nConnected channels:');
      connected.forEach((c, i) => console.log(`  ${i + 1}) ${capitalize(c)}`));
      const sel = (await ask(rl, 'Choose channel to remove: ')).trim();
      const chIdx = parseInt(sel, 10) - 1;
      if (chIdx < 0 || chIdx >= connected.length) {
        console.log('  Invalid choice.');
        continue;
      }
      const ch = connected[chIdx];
      const confirm = (await ask(rl, `  Remove ${capitalize(ch)} from "${agent.id}"? This will delete .${ch}-state/ (y/N): `)).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') {
        console.log('  Cancelled.');
        continue;
      }

      // Reload config in case it changed
      const freshConfig = loadConfig();
      const freshAgent = findAgent(freshConfig, agentId)!;
      removeChannel(freshConfig, freshAgent, ch);
      // Update local ref
      Object.assign(agent, freshAgent);
    }
  }
}

async function setupChannel(agent: AgentEntry, channel: ChannelId, config: GatewayConfig): Promise<void> {
  const { promptBotToken, appendToConfig, workspaceDir } = await import('./create-agent');
  const wsDir = expandHome(agent.workspace);
  const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  if (channel === 'telegram') {
    console.log('Setting up Telegram:\n');
    console.log('  1. Open Telegram and search for @BotFather');
    console.log('  2. Send: /newbot, follow prompts, copy the token.\n');
    const { token } = await promptBotToken(rl2, agent.id);
    rl2.close();
    const agentsMd = readAgentsMd(wsDir);
    await appendToConfig(agent.id, wsDir, agentsMd, { channel: 'telegram', token });
    console.log(`  ✓ Telegram configured for agent "${agent.id}"`);
    console.log(`  Run: make pair agent=${agent.id} code=<code>`);
  } else {
    const { verifyDiscordBotToken, DISCORD_TOKEN_REGEX } = await import('./create-agent');
    console.log('Setting up Discord:\n');
    console.log('  1. Go to https://discord.com/developers/applications');
    console.log('  2. Create/select app → Bot → Enable MESSAGE CONTENT INTENT → Copy token.\n');

    let token = '';
    let username = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await new Promise<string>(resolve => rl2.question('Discord bot token: ', resolve));
      const t = raw.trim();
      if (!DISCORD_TOKEN_REGEX.test(t)) {
        console.log('  Invalid token format.');
        continue;
      }
      process.stdout.write('  Verifying...');
      const { ok, username: u } = await verifyDiscordBotToken(t);
      process.stdout.write('\r              \r');
      if (ok) { token = t; username = u; break; }
      console.log(`  Verification failed. ${3 - attempt} attempt(s) remaining.`);
    }
    rl2.close();
    if (!token) { console.error('Could not verify Discord token. Aborting.'); process.exit(1); }
    console.log(`  ✓ Bot @${username} verified`);

    // Save token to agentDir/.env
    const discordEnvVar = agent.id.toUpperCase().replace(/-/g, '_') + '_DISCORD_BOT_TOKEN';
    const agentEnvFile = path.join(gatewayDir(), 'agents', agent.id, '.env');
    fs.mkdirSync(path.dirname(agentEnvFile), { recursive: true });
    let existing = '';
    try { existing = fs.readFileSync(agentEnvFile, 'utf8'); } catch {}
    if (!existing.includes(`${discordEnvVar}=`)) {
      fs.appendFileSync(agentEnvFile, `${discordEnvVar}=${token}\n`, { mode: 0o600 });
    }

    const agentsMd = readAgentsMd(wsDir);
    await appendToConfig(agent.id, wsDir, agentsMd, { channel: 'discord', token });
    console.log(`  ✓ Discord configured for agent "${agent.id}"`);
    console.log(`  Run: make pair agent=${agent.id} code=<code> channel=discord`);
  }
}

function readAgentsMd(wsDir: string): string {
  try { return fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) result[m[1]] = m[2];
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs();
  const agentId = args['agent'];
  if (!agentId) {
    console.error('Usage: make update-agent-channel agent=<agentId>');
    process.exit(1);
  }
  runMenu(agentId).catch(err => {
    console.error('\nFatal error:', (err as Error).message);
    process.exit(1);
  });
}
