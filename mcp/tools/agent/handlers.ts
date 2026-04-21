import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeTelegramAccess, writeDiscordAccess } from '../../../lib/pairing';

// ---------------------------------------------------------------------------
// Regex constants (exported for tests)
// ---------------------------------------------------------------------------

export const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;
export const TELEGRAM_TOKEN_REGEX = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;
export const DISCORD_TOKEN_REGEX = /^\w{24,}\.\w{6}\.[\w-]{27,}$/;

const FILENAME_SAFE_REGEX = /^[A-Z][A-Z0-9_-]*\.md$/i;
const STANDARD_STUB_FILES = ['HEARTBEAT.md', 'MEMORY.md', 'SOUL.md', 'USER.md'];

// ---------------------------------------------------------------------------
// Path helpers (local copies — same as scripts/create-agent.ts)
// ---------------------------------------------------------------------------

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function configPath(): string {
  const envPath = process.env['GATEWAY_CONFIG'];
  if (envPath) return expandHome(envPath);
  return path.join(os.homedir(), '.claude-gateway', 'config.json');
}

function gatewayDir(): string {
  return path.dirname(configPath());
}

function agentRootDir(agentId: string): string {
  return path.join(gatewayDir(), 'agents', agentId);
}

export function workspaceDir(agentId: string): string {
  return path.join(agentRootDir(agentId), 'workspace');
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

interface RawConfig {
  gateway: { logDir: string; timezone: string };
  agents: RawAgentEntry[];
  [key: string]: unknown;
}

interface RawAgentEntry {
  id: string;
  description: string;
  workspace: string;
  env: string;
  telegram?: { botToken: string };
  discord?: { botToken: string };
  claude: { model: string; dangerouslySkipPermissions: boolean; extraFlags: string[] };
  signatureEmoji?: string;
  [key: string]: unknown;
}

function loadRawConfig(): RawConfig {
  const cp = configPath();
  return JSON.parse(fs.readFileSync(cp, 'utf8')) as RawConfig;
}

function saveRawConfig(config: RawConfig): void {
  const cp = configPath();
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Token verification (fetch — Bun native, no https module)
// ---------------------------------------------------------------------------

export async function verifyTelegramToken(token: string): Promise<{ ok: boolean; username: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = await res.json() as { ok: boolean; result?: { username?: string } };
    if (json.ok && json.result?.username) {
      return { ok: true, username: json.result.username };
    }
    return { ok: false, username: '' };
  } catch {
    return { ok: false, username: '' };
  }
}

export async function verifyDiscordToken(token: string): Promise<{ ok: boolean; username: string }> {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    const json = await res.json() as { username?: string };
    return { ok: res.status === 200, username: json.username ?? '' };
  } catch {
    return { ok: false, username: '' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return text.trim().slice(0, 80);
}

function envVarName(agentId: string, channel: 'telegram' | 'discord'): string {
  const base = agentId.toUpperCase().replace(/-/g, '_');
  return channel === 'telegram' ? `${base}_BOT_TOKEN` : `${base}_DISCORD_BOT_TOKEN`;
}

function howToFindUserId(channel: 'telegram' | 'discord'): string {
  if (channel === 'telegram') {
    return [
      'No user_id provided — allowFrom is empty (nobody can DM the bot yet).',
      'To grant access, find your Telegram user ID:',
      '  • Send /start to @userinfobot, or',
      '  • Forward any message to @getidsbot',
      'Then use the telegram:access tool to add your ID.',
    ].join('\n');
  }
  return [
    'No user_id provided — allowFrom is empty (nobody can DM the bot yet).',
    'To grant access, find your Discord user ID:',
    '  • Settings → Advanced → enable Developer Mode',
    '  • Right-click your username → Copy User ID',
    'Then use the discord:discord-access tool to add your ID.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// agent_create
// ---------------------------------------------------------------------------

export interface CreateAgentArgs {
  id: string;
  description: string;
  channel: 'telegram' | 'discord';
  bot_token: string;
  /** @deprecated use telegram_user_id or discord_user_id */
  user_id?: string;
  telegram_user_id?: string;
  discord_user_id?: string;
  dm_policy?: 'open' | 'allowlist' | 'pairing';
  model?: string;
  signature_emoji?: string;
  agents_md?: string;
  soul_md?: string;
  user_md?: string;
}

export async function createAgent(args: CreateAgentArgs): Promise<string> {
  const { id, description, channel, bot_token } = args;
  const dmPolicy = args.dm_policy ?? 'allowlist';
  const model = args.model ?? 'claude-sonnet-4-6';

  // 1. Validate id
  if (!NAME_REGEX.test(id)) {
    throw new Error(
      `Invalid agent id "${id}": must start with a letter, 2-32 chars, letters/numbers/underscores/hyphens only`
    );
  }
  const agentId = id.toLowerCase();

  // 2. Validate description
  if (!description || description.trim().length === 0) {
    throw new Error('description is required and must not be empty');
  }

  // 3. Validate channel
  if (channel !== 'telegram' && channel !== 'discord') {
    throw new Error(`Unsupported channel "${channel}". Must be "telegram" or "discord"`);
  }

  // 4. Validate token format
  if (channel === 'telegram' && !TELEGRAM_TOKEN_REGEX.test(bot_token)) {
    throw new Error('Invalid Telegram bot token format. Expected: 123456789:AAHfiq...');
  }
  if (channel === 'discord' && !DISCORD_TOKEN_REGEX.test(bot_token)) {
    throw new Error('Invalid Discord bot token format. Expected: MTAxMTk....AAAA.xxx...');
  }

  // 5. Check uniqueness in config.json before any file writes
  let config: RawConfig;
  try {
    config = loadRawConfig();
  } catch (err) {
    throw new Error(`Cannot read config.json: ${(err as Error).message}`);
  }
  if (config.agents.some((a) => a.id === agentId)) {
    throw new Error(`Agent "${agentId}" already exists in config.json`);
  }

  // 6. Verify token via upstream API (fail fast before any file writes)
  let botUsername: string;
  if (channel === 'telegram') {
    const result = await verifyTelegramToken(bot_token);
    if (!result.ok) {
      throw new Error('Telegram token verification failed: getMe returned not ok. Check the token.');
    }
    botUsername = result.username;
  } else {
    const result = await verifyDiscordToken(bot_token);
    if (!result.ok) {
      throw new Error('Discord token verification failed: /api/v10/users/@me returned non-200. Check the token.');
    }
    botUsername = result.username;
  }

  // 7. Create workspace directory
  const wsDir = workspaceDir(agentId);
  fs.mkdirSync(wsDir, { recursive: true });

  // 8. Write workspace files
  const agentsMdContent =
    args.agents_md ??
    `# Agent: ${agentId.charAt(0).toUpperCase() + agentId.slice(1)}\n\n${description}`;
  fs.writeFileSync(path.join(wsDir, 'AGENTS.md'), agentsMdContent, 'utf8');

  if (args.soul_md) {
    fs.writeFileSync(path.join(wsDir, 'SOUL.md'), args.soul_md, 'utf8');
  }
  if (args.user_md) {
    fs.writeFileSync(path.join(wsDir, 'USER.md'), args.user_md, 'utf8');
  }

  // Write stub files for any standard files not yet present
  for (const stub of STANDARD_STUB_FILES) {
    const stubPath = path.join(wsDir, stub);
    if (!fs.existsSync(stubPath)) {
      fs.writeFileSync(stubPath, '', 'utf8');
    }
  }

  // 9. Write .env for the agent (mode 0o600 — owner read-only)
  const envVar = envVarName(agentId, channel);
  const agentEnvFile = path.join(agentRootDir(agentId), '.env');
  fs.writeFileSync(agentEnvFile, `${envVar}=${bot_token}\n`, { mode: 0o600 });

  // 10. Create channel state dir + write access.json immediately (no pairing flow)
  const stateDir = path.join(wsDir, `.${channel}-state`);
  fs.mkdirSync(stateDir, { recursive: true });

  if (channel === 'discord') {
    fs.writeFileSync(
      path.join(stateDir, '.env'),
      `DISCORD_BOT_TOKEN=${bot_token}\n`,
      { mode: 0o600 }
    );
  }

  const userId = (channel === 'telegram'
    ? (args.telegram_user_id ?? args.user_id)
    : (args.discord_user_id ?? args.user_id)
  )?.trim() ?? '';
  if (channel === 'telegram') {
    if (userId) {
      writeTelegramAccess(stateDir, userId);
    } else {
      fs.writeFileSync(
        path.join(stateDir, 'access.json'),
        JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }, null, 2),
        { mode: 0o600 }
      );
    }
  } else {
    if (userId) {
      writeDiscordAccess(stateDir, userId);
    } else {
      fs.writeFileSync(
        path.join(stateDir, 'access.json'),
        JSON.stringify(
          { dmPolicy: 'allowlist', allowFrom: [], guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {} },
          null,
          2
        ) + '\n',
        { mode: 0o600 }
      );
    }
  }

  // 11. Update config.json (gateway hot-adds the agent automatically)
  const descriptionText = firstNonEmptyLine(agentsMdContent);
  const newAgent: RawAgentEntry = {
    id: agentId,
    description: descriptionText,
    workspace: wsDir.replace(os.homedir(), '~'),
    env: '',
    claude: {
      model,
      dangerouslySkipPermissions: true,
      extraFlags: [],
    },
  };

  if (channel === 'telegram') {
    newAgent.telegram = { botToken: `\${${envVar}}` };
  } else {
    newAgent.discord = { botToken: `\${${envVar}}` };
  }

  if (args.signature_emoji) {
    newAgent.signatureEmoji = args.signature_emoji;
  }

  config.agents.push(newAgent);
  saveRawConfig(config);

  const accessNote = userId
    ? `Access granted to user ID: ${userId}`
    : howToFindUserId(channel);

  return [
    `Agent "${agentId}" created successfully!`,
    `Bot: @${botUsername}`,
    `Workspace: ${wsDir.replace(os.homedir(), '~')}`,
    `Channel: ${channel} (dm_policy: ${dmPolicy})`,
    '',
    accessNote,
    '',
    'The gateway will detect the new agent and start it automatically (hot-add).',
    'If the agent does not appear, restart the gateway: make restart (or: pm2 restart gateway)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// agent_update
// ---------------------------------------------------------------------------

export interface UpdateAgentArgs {
  id: string;
  action: 'add_channel' | 'remove_channel' | 'update_workspace_file';
  channel?: 'telegram' | 'discord';
  bot_token?: string;
  /** @deprecated use telegram_user_id or discord_user_id */
  user_id?: string;
  telegram_user_id?: string;
  discord_user_id?: string;
  dm_policy?: 'open' | 'allowlist' | 'pairing';
  filename?: string;
  content?: string;
}

export async function updateAgent(args: UpdateAgentArgs): Promise<string> {
  const { id, action } = args;

  // Validate id
  if (!NAME_REGEX.test(id)) {
    throw new Error(`Invalid agent id "${id}"`);
  }
  const agentId = id.toLowerCase();

  // Load config
  let config: RawConfig;
  try {
    config = loadRawConfig();
  } catch (err) {
    throw new Error(`Cannot read config.json: ${(err as Error).message}`);
  }

  const agentIdx = config.agents.findIndex((a) => a.id === agentId);
  if (agentIdx < 0) {
    throw new Error(`Agent "${agentId}" not found in config.json`);
  }
  const agent = config.agents[agentIdx];
  const wsDir = expandHome(agent.workspace);

  // ── Action: add_channel ──────────────────────────────────────────────────
  if (action === 'add_channel') {
    const channel = args.channel;
    const bot_token = args.bot_token;
    const dmPolicy = args.dm_policy ?? 'allowlist';

    if (!channel || (channel !== 'telegram' && channel !== 'discord')) {
      throw new Error('add_channel requires channel: "telegram" or "discord"');
    }
    if (!bot_token) {
      throw new Error('add_channel requires bot_token');
    }

    // Assert channel not already configured
    if (channel === 'telegram' && agent.telegram?.botToken) {
      throw new Error(`Agent "${agentId}" already has a Telegram channel configured`);
    }
    if (channel === 'discord' && agent.discord?.botToken) {
      throw new Error(`Agent "${agentId}" already has a Discord channel configured`);
    }

    // Validate token format
    if (channel === 'telegram' && !TELEGRAM_TOKEN_REGEX.test(bot_token)) {
      throw new Error('Invalid Telegram bot token format');
    }
    if (channel === 'discord' && !DISCORD_TOKEN_REGEX.test(bot_token)) {
      throw new Error('Invalid Discord bot token format');
    }

    // Verify token
    let botUsername: string;
    if (channel === 'telegram') {
      const result = await verifyTelegramToken(bot_token);
      if (!result.ok) throw new Error('Telegram token verification failed');
      botUsername = result.username;
    } else {
      const result = await verifyDiscordToken(bot_token);
      if (!result.ok) throw new Error('Discord token verification failed');
      botUsername = result.username;
    }

    // Append token to agent .env
    const envVar = envVarName(agentId, channel);
    const agentEnvFile = path.join(agentRootDir(agentId), '.env');
    fs.mkdirSync(path.dirname(agentEnvFile), { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(agentEnvFile, 'utf8');
    } catch {}
    if (!existing.includes(`${envVar}=`)) {
      fs.appendFileSync(agentEnvFile, `${envVar}=${bot_token}\n`, { mode: 0o600 });
    }

    // Create state dir + write access.json immediately (no pairing flow)
    const stateDir = path.join(wsDir, `.${channel}-state`);
    fs.mkdirSync(stateDir, { recursive: true });

    if (channel === 'discord') {
      fs.writeFileSync(
        path.join(stateDir, '.env'),
        `DISCORD_BOT_TOKEN=${bot_token}\n`,
        { mode: 0o600 }
      );
    }

    const addUserId = (channel === 'telegram'
      ? (args.telegram_user_id ?? args.user_id)
      : (args.discord_user_id ?? args.user_id)
    )?.trim() ?? '';
    if (channel === 'telegram') {
      if (addUserId) {
        writeTelegramAccess(stateDir, addUserId);
      } else {
        fs.writeFileSync(
          path.join(stateDir, 'access.json'),
          JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], groups: {}, pending: {} }, null, 2),
          { mode: 0o600 }
        );
      }
    } else {
      if (addUserId) {
        writeDiscordAccess(stateDir, addUserId);
      } else {
        fs.writeFileSync(
          path.join(stateDir, 'access.json'),
          JSON.stringify(
            { dmPolicy: 'allowlist', allowFrom: [], guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {} },
            null,
            2
          ) + '\n',
          { mode: 0o600 }
        );
      }
    }

    // Update config.json (so gateway can hot-add)
    if (channel === 'telegram') {
      config.agents[agentIdx].telegram = { botToken: `\${${envVar}}` };
    } else {
      config.agents[agentIdx].discord = { botToken: `\${${envVar}}` };
    }
    saveRawConfig(config);

    const addAccessNote = addUserId
      ? `Access granted to user ID: ${addUserId}`
      : howToFindUserId(channel);

    return [
      `Channel "${channel}" added to agent "${agentId}". Bot: @${botUsername}`,
      '',
      addAccessNote,
      '',
      'If the channel does not connect, restart the gateway: make restart (or: pm2 restart gateway)',
    ].join('\n');
  }

  // ── Action: remove_channel ───────────────────────────────────────────────
  if (action === 'remove_channel') {
    const channel = args.channel;
    if (!channel || (channel !== 'telegram' && channel !== 'discord')) {
      throw new Error('remove_channel requires channel: "telegram" or "discord"');
    }

    // Assert channel exists on agent
    if (channel === 'telegram' && !agent.telegram?.botToken) {
      throw new Error(`Agent "${agentId}" does not have a Telegram channel configured`);
    }
    if (channel === 'discord' && !agent.discord?.botToken) {
      throw new Error(`Agent "${agentId}" does not have a Discord channel configured`);
    }

    // Remove state dir
    const stateDir = path.join(wsDir, `.${channel}-state`);
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {}

    // Strip token line from agent .env
    const envVar = envVarName(agentId, channel);
    const agentEnvFile = path.join(agentRootDir(agentId), '.env');
    try {
      const lines = fs
        .readFileSync(agentEnvFile, 'utf8')
        .split('\n')
        .filter((l) => !l.startsWith(`${envVar}=`));
      fs.writeFileSync(agentEnvFile, lines.join('\n'), { mode: 0o600 });
    } catch {}

    // Remove from config.json
    if (channel === 'telegram') {
      delete config.agents[agentIdx].telegram;
    } else {
      delete config.agents[agentIdx].discord;
    }
    saveRawConfig(config);

    return `Channel "${channel}" removed from agent "${agentId}".`;
  }

  // ── Action: update_workspace_file ────────────────────────────────────────
  if (action === 'update_workspace_file') {
    const filename = args.filename;
    const content = args.content;

    if (!filename) throw new Error('update_workspace_file requires filename');
    if (content === undefined) throw new Error('update_workspace_file requires content');

    // Validate filename — no path traversal, no path components
    if (
      !FILENAME_SAFE_REGEX.test(filename) ||
      filename.includes('/') ||
      filename.includes('\\') ||
      filename.includes('..')
    ) {
      throw new Error(
        'Invalid filename. Must match /^[A-Z][A-Z0-9_-]*\\.md$/i with no path components'
      );
    }

    const filePath = path.join(wsDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');

    return `File "${filename}" updated in workspace for agent "${agentId}". Gateway workspace-watcher will auto-reload CLAUDE.md.`;
  }

  throw new Error(
    `Unknown action "${action}". Must be one of: add_channel, remove_channel, update_workspace_file`
  );
}
