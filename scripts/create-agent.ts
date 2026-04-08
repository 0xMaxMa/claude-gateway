/**
 * create-agent: Interactive wizard to create a new Claude Gateway agent.
 *
 * Steps:
 *  1. Agent name
 *  2. Description → AI-generated workspace files
 *  3. Create workspace + update config
 *  4. BotFather instructions + token input
 *  5. Start agent + auto-approve Telegram pairing
 *  6. Send welcome message + print summary
 *
 * Resume: wizard state is saved after each step to ~/.claude-gateway/.wizard-state.json
 * If interrupted, re-run `npm run create-agent` to resume from the last step.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import * as https from 'https';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { loadWorkspace } from '../src/workspace-loader';
import { buildGenerationPrompt, parseGeneratedFiles } from './create-agent-prompts';
import { interactiveSelect } from './interactive-select';
import { loadCleanTemplate, stripIgnoredPaths } from '../src/config-migrator';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function gatewayDir(): string {
  return path.join(os.homedir(), '.claude-gateway');
}

function configPath(): string {
  const envPath = process.env['GATEWAY_CONFIG'];
  if (envPath) return expandHome(envPath);
  return path.join(gatewayDir(), 'config.json');
}

function agentDir(agentId: string): string {
  return path.join(gatewayDir(), 'agents', agentId);
}

function workspaceDir(agentId: string): string {
  return path.join(agentDir(agentId), 'workspace');
}

// ---------------------------------------------------------------------------
// Wizard state (resume support)
// ---------------------------------------------------------------------------

interface WizardState {
  agentId: string;
  agentName: string;
  lastCompletedStep: number; // 1-6
  wsDir?: string;
  token?: string;
  botUsername?: string;
  chatId?: string;
}

function wizardStatePath(): string {
  return path.join(gatewayDir(), '.wizard-state.json');
}

function saveWizardState(state: WizardState): void {
  fs.mkdirSync(gatewayDir(), { recursive: true });
  fs.writeFileSync(wizardStatePath(), JSON.stringify(state, null, 2), 'utf8');
}

function loadWizardState(): WizardState | null {
  try {
    const raw = fs.readFileSync(wizardStatePath(), 'utf8');
    return JSON.parse(raw) as WizardState;
  } catch {
    return null;
  }
}

function clearWizardState(): void {
  try {
    fs.unlinkSync(wizardStatePath());
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Config management
// ---------------------------------------------------------------------------

interface RawConfig {
  gateway: { logDir: string; timezone: string };
  agents: RawAgentEntry[];
}

interface RawAgentEntry {
  id: string;
  description: string;
  workspace: string;
  env: string;
  telegram: {
    botToken: string;
    allowedUsers: number[];
    dmPolicy: string;
  };
  claude: {
    model: string;
    dangerouslySkipPermissions: boolean;
    extraFlags: string[];
  };
  emojiReactionMode?: 'minimal' | 'extensive' | 'none';
  signatureEmoji?: string;
}

function loadOrCreateRawConfig(): RawConfig {
  const cp = configPath();
  if (fs.existsSync(cp)) {
    const raw = fs.readFileSync(cp, 'utf8');
    return JSON.parse(raw) as RawConfig;
  }

  // First run: try to load from template
  const templatePath = path.join(__dirname, '..', 'config.template.json');
  try {
    const { template, ignorePaths } = loadCleanTemplate(templatePath);
    stripIgnoredPaths(template, ignorePaths);
    template.agents = [];
    return template as unknown as RawConfig;
  } catch {
    // Template missing or unreadable — use hardcoded fallback
    return {
      gateway: { logDir: '~/.claude-gateway/logs', timezone: 'UTC' },
      agents: [],
    };
  }
}

function saveConfig(config: RawConfig): void {
  const cp = configPath();
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return text.trim().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Step 1 — Agent Name
// ---------------------------------------------------------------------------

export const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;

export async function promptAgentName(rl: readline.Interface, existingIds: string[]): Promise<string> {
  while (true) {
    const raw = await prompt(rl, 'Agent name (letters, numbers, hyphens only): ');
    const name = raw.trim();

    if (!NAME_REGEX.test(name)) {
      console.log('  Name must start with a letter and contain only letters, numbers, underscores, or hyphens (2-32 chars).');
      continue;
    }

    const agentId = name.toLowerCase();

    if (existingIds.includes(agentId)) {
      console.log(`  "${agentId}" already exists. Choose another name.`);
      continue;
    }

    const wsDir = workspaceDir(agentId);
    if (fs.existsSync(wsDir)) {
      const answer = await prompt(rl, `  Directory ${wsDir} already exists. Overwrite? (yes/rename/cancel) [cancel]: `);
      const choice = answer.trim().toLowerCase();
      if (choice === 'yes' || choice === 'y') {
        return agentId;
      } else if (choice === 'rename' || choice === 'r') {
        continue;
      } else {
        console.log('Cancelled.');
        process.exit(0);
      }
    }

    return agentId;
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Description
// ---------------------------------------------------------------------------

async function promptDescription(rl: readline.Interface): Promise<string> {
  console.log('\nDescribe the agent\'s role, personality, and capabilities.');
  console.log('Examples:');
  console.log('  "A formal English butler assistant for personal tasks"');
  console.log('  "A Thai-language customer support bot for my SaaS product"');
  console.log('  "A daily coding assistant that reviews PRs and sends morning summaries"');
  console.log('\n(Enter a blank line when done)');

  const lines: string[] = [];
  while (true) {
    const line = await prompt(rl, '');
    if (line.trim() === '' && lines.length > 0) break;
    if (line.trim() !== '') lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Minimal fallback templates when Claude generation fails.
 */
function fallbackFiles(agentId: string): Map<string, string> {
  const name = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  const files = new Map<string, string>();
  files.set(
    'agent.md',
    `# Agent: ${name}\n\nYou are ${name}, a helpful assistant.\n\n<!-- TODO: Describe your agent's role, rules, and capabilities. -->`
  );
  return files;
}

interface GenerateResult {
  files: Map<string, string>;
  suggestedEmoji?: string;
}

// Extract a single emoji from the first line of text (Claude suggests one)
function extractLeadingEmoji(text: string): { emoji: string | undefined; rest: string } {
  const firstLine = text.split('\n')[0].trim();
  // Match a single emoji (including compound emoji with ZWJ, skin tones, etc.)
  const emojiMatch = firstLine.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*$/u);
  if (emojiMatch) {
    // Remove the emoji line from content
    const rest = text.slice(text.indexOf('\n') + 1).trim();
    return { emoji: firstLine, rest };
  }
  return { emoji: undefined, rest: text };
}

async function generateFiles(
  agentId: string,
  description: string,
  options?: { signatureEmoji?: string; emojiReactionMode?: string }
): Promise<GenerateResult> {
  const agentName = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  console.log('\nGenerating workspace files with Claude...');

  const genPrompt = buildGenerationPrompt(agentName, description, options);
  const result = spawnSync('claude', ['--print'], {
    input: genPrompt,
    encoding: 'utf8',
    timeout: 60000,
  });

  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    console.log('  Warning: Claude generation failed. Using minimal fallback templates.');
    return { files: fallbackFiles(agentId) };
  }

  // Strip wrapping code fences that Claude sometimes adds
  let raw = result.stdout.trim();
  const fenceMatch = raw.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    raw = fenceMatch[1].trim();
  }

  // Extract suggested emoji from first line
  const { emoji: suggestedEmoji, rest } = extractLeadingEmoji(raw);
  if (suggestedEmoji) {
    raw = rest;
  }

  const parsed = parseGeneratedFiles(raw);
  if (!parsed.has('agent.md')) {
    // Fallback: if Claude output looks like markdown content without markers, use as agent.md
    const headingIdx = raw.indexOf('# ');
    if (headingIdx >= 0) {
      const content = raw.slice(headingIdx).replace(/\n```\s*$/, '').trim();
      if (content.length > 50) {
        console.log('  Note: Claude output had no section markers — treating as agent.md');
        parsed.set('agent.md', content);
        return { files: parsed, suggestedEmoji };
      }
    }
    console.log('  Warning: agent.md not found in Claude output. Using minimal fallback templates.');
    return { files: fallbackFiles(agentId) };
  }

  return { files: parsed, suggestedEmoji };
}

// ---------------------------------------------------------------------------
// Step 2 — Preview and accept generated files
// ---------------------------------------------------------------------------

const OPTIONAL_FILES = new Set(['soul.md', 'user.md', 'tools.md', 'heartbeat.md', 'bootstrap.md']);
const SEPARATOR_WIDTH = 42;

export function printFilePreview(filename: string, content: string): void {
  const label = `─── ${filename} `;
  const padding = Math.max(0, SEPARATOR_WIDTH - label.length);
  console.log('\n' + label + '─'.repeat(padding));
  console.log(content);
  console.log('─'.repeat(SEPARATOR_WIDTH));
}

async function previewAndAccept(
  rl: readline.Interface,
  files: Map<string, string>
): Promise<Map<string, string>> {
  const accepted = new Map<string, string>();

  for (const [filename, content] of files) {
    printFilePreview(filename, content);

    while (true) {
      const answer = await prompt(rl, 'Accept? (y/edit/skip) [y]: ');
      const choice = answer.trim().toLowerCase() || 'y';

      if (choice === 'y' || choice === 'yes' || choice === '') {
        accepted.set(filename, content);
        break;
      } else if (choice === 'edit') {
        const tmpFile = path.join(os.tmpdir(), `claude-gateway-${filename}`);
        fs.writeFileSync(tmpFile, content, 'utf8');

        const editorCandidates = [
          process.env['VISUAL'],
          process.env['EDITOR'],
          'vim',
          'vi',
          'nano',
        ].filter(Boolean) as string[];

        let editResult: ReturnType<typeof spawnSync> | null = null;
        let usedEditor = '';
        for (const candidate of editorCandidates) {
          const result = spawnSync(candidate, [tmpFile], { stdio: 'inherit' });
          if (!result.error) {
            editResult = result;
            usedEditor = candidate;
            break;
          }
        }

        if (!editResult) {
          console.log(
            '  Could not open any editor (tried: ' +
              editorCandidates.join(', ') +
              ').\n  Set $EDITOR and try again, or choose y/skip.'
          );
          fs.unlinkSync(tmpFile);
          // No break — loop continues, re-prompting the user
        } else {
          const edited = fs.readFileSync(tmpFile, 'utf8');
          fs.unlinkSync(tmpFile);
          accepted.set(filename, edited);
          printFilePreview(filename, edited);
          console.log(`  (edited with ${usedEditor}, accepted)`);
          break;
        }
      } else if (choice === 'skip') {
        if (OPTIONAL_FILES.has(filename)) {
          console.log(`  Skipping ${filename}`);
          break;
        } else {
          console.log(`  Cannot skip ${filename} — it is required.`);
        }
      } else {
        console.log('  Please enter y, edit, or skip.');
      }
    }
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// Step 3 — Create workspace + update config
// ---------------------------------------------------------------------------

export async function createWorkspace(agentId: string, files: Map<string, string>): Promise<string> {
  const wsDir = workspaceDir(agentId);
  console.log('\nCreating workspace...');
  fs.mkdirSync(wsDir, { recursive: true });
  console.log(`  ✓ ${wsDir.replace(os.homedir(), '~')}/`);

  for (const [filename, content] of files) {
    const filePath = path.join(wsDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  ✓ ${filename}`);
  }

  return wsDir;
}

export async function appendToConfig(
  agentId: string,
  wsDir: string,
  agentMdContent: string,
  options?: { emojiReactionMode?: 'minimal' | 'extensive' | 'none'; signatureEmoji?: string }
): Promise<void> {
  console.log('Updating config.json...');

  const config = loadOrCreateRawConfig();
  config.agents = config.agents.filter((a) => a.id !== agentId);

  const envVarName = agentId.toUpperCase().replace(/-/g, '_') + '_BOT_TOKEN';
  const descriptionText = firstNonEmptyLine(agentMdContent);

  const newAgent: RawAgentEntry = {
    id: agentId,
    description: descriptionText,
    workspace: wsDir.replace(os.homedir(), '~'),
    env: '',
    telegram: {
      botToken: `\${${envVarName}}`,
      allowedUsers: [],
      dmPolicy: 'open',
    },
    claude: {
      model: 'claude-sonnet-4-6',
      dangerouslySkipPermissions: true,
      extraFlags: [],
    },
  };

  if (options?.emojiReactionMode) {
    newAgent.emojiReactionMode = options.emojiReactionMode;
  }
  if (options?.signatureEmoji) {
    newAgent.signatureEmoji = options.signatureEmoji;
  }

  config.agents.push(newAgent);
  saveConfig(config);
  console.log(`  ✓ Agent "${agentId}" added`);
}

// ---------------------------------------------------------------------------
// Step 4 — BotFather instructions + token
// ---------------------------------------------------------------------------

export const TOKEN_REGEX = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

export async function verifyBotToken(token: string): Promise<{ ok: boolean; username: string }> {
  try {
    const url = `https://api.telegram.org/bot${token}/getMe`;
    const body = await httpsGet(url);
    const json = JSON.parse(body) as { ok: boolean; result?: { username?: string } };
    if (json.ok && json.result?.username) {
      return { ok: true, username: json.result.username };
    }
    return { ok: false, username: '' };
  } catch {
    return { ok: false, username: '' };
  }
}

async function promptBotToken(
  rl: readline.Interface,
  agentId: string
): Promise<{ token: string; username: string }> {
  let attempts = 0;
  const MAX_ATTEMPTS = 3;

  while (attempts < MAX_ATTEMPTS) {
    // Plain visible input — no masking (paste-friendly)
    const raw = await prompt(rl, 'Bot token: ');
    const token = raw.trim();

    if (!TOKEN_REGEX.test(token)) {
      console.log('  Invalid token format. Expected: 123456789:AAHfiqksKZ8WmHPDK...');
      attempts++;
      if (attempts < MAX_ATTEMPTS) console.log(`  ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`);
      continue;
    }

    process.stdout.write('  Verifying token...');
    const { ok, username } = await verifyBotToken(token);
    if (ok) {
      process.stdout.write('\r                      \r');
      console.log(`  ✓ Bot @${username} verified`);

      // Store token in .env for the agent dir
      const envVarName = agentId.toUpperCase().replace(/-/g, '_') + '_BOT_TOKEN';
      process.env[envVarName] = token;
      const agentEnvDir = agentDir(agentId);
      fs.mkdirSync(agentEnvDir, { recursive: true });
      fs.writeFileSync(path.join(agentEnvDir, '.env'), `${envVarName}=${token}\n`, 'utf8');

      return { token, username };
    } else {
      process.stdout.write('\r                      \r');
      attempts++;
      if (attempts >= MAX_ATTEMPTS) {
        console.log('\n  Max attempts reached.');
        break;
      }
      console.log(`  Invalid token (getMe failed). ${MAX_ATTEMPTS - attempts} attempt(s) remaining.`);
    }
  }

  console.log('\nCould not verify bot token. Please check the token from BotFather and try again.');
  console.log(`Run "npm run create-agent" to restart.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 5 — Start agent + auto-approve pairing
// ---------------------------------------------------------------------------

interface AccessJson {
  dmPolicy: string;
  allowFrom: string[];
  groups: Record<string, unknown>;
  pending: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Direct Telegram polling — used during pairing (no subprocess needed)
// ---------------------------------------------------------------------------

interface TgMessage {
  message_id: number;
  from: { id: number; username?: string };
  chat: { id: number; type: string };
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

/**
 * Poll Telegram getUpdates until the first private DM arrives.
 * Returns { senderId, chatId } from the first message.
 * Uses long-polling (timeout=30s per request) to avoid busy-waiting.
 */
export async function pollForFirstMessage(
  token: string,
  timeoutMs = 3 * 60 * 1000,
): Promise<{ senderId: string; chatId: string }> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let dotCount = 0;
  process.stdout.write('Waiting for pairing.');

  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const pollSecs = Math.min(30, Math.ceil(remaining / 1000));
    if (pollSecs === 0) break;

    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${pollSecs}&allowed_updates=%5B%22message%22%5D`;
      const body = await httpsGet(url);
      const data = JSON.parse(body) as { ok: boolean; result: TgUpdate[] };

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          if (update.message?.chat.type === 'private') {
            process.stdout.write('\n');
            return {
              senderId: String(update.message.from.id),
              chatId: String(update.message.chat.id),
            };
          }
        }
        // Non-private updates — advance offset and continue
        continue;
      }
    } catch {
      // Network blip — back off briefly and retry
      await sleep(2000);
    }

    dotCount++;
    const dots = '.'.repeat((dotCount % 6) + 1);
    process.stdout.write(`\rWaiting for pairing${dots}      \r`);
    process.stdout.write(`Waiting for pairing${dots}`);
  }

  process.stdout.write('\n');
  throw new Error('Pairing timeout — no message received within 3 minutes');
}

async function startAndPair(
  agentId: string,
  token: string,
  wsDir: string,
  botUsername: string
): Promise<string> {
  const telegramStateDir = path.join(wsDir, '.telegram-state');
  fs.mkdirSync(telegramStateDir, { recursive: true });

  // Write CLAUDE.md so the agent has context when it starts for real
  try {
    const loaded = await loadWorkspace(wsDir);
    fs.writeFileSync(path.join(wsDir, 'CLAUDE.md'), loaded.systemPrompt, 'utf8');
  } catch {
    // Not fatal — agent works without it
  }

  console.log(`Now open Telegram and send ANY message to @${botUsername}\n`);

  let senderId: string;
  let chatId: string;
  try {
    const result = await pollForFirstMessage(token);
    senderId = result.senderId;
    chatId = result.chatId;
  } catch (err) {
    console.error(`\n  ${(err as Error).message}`);
    console.error('  To pair manually, run the gateway and send a message to the bot.');
    process.exit(1);
  }

  console.log(`  ✓ Pairing request received from user ${senderId}`);

  // Generate a 6-char pairing code (same format as the plugin)
  const pairingCode = randomBytes(3).toString('hex');

  // Send pairing code to the user in Telegram
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await httpsPost(
      url,
      JSON.stringify({
        chat_id: chatId,
        text: `Pairing code: ${pairingCode}\n\nEnter this code in the setup wizard to complete pairing.`,
      }),
    );
  } catch {
    // Not fatal — continue regardless
  }

  console.log(`\nThe bot just sent a pairing code to your Telegram.`);

  // Ask user to enter the code in terminal to confirm they received it
  const rlConfirm = createRl();
  let confirmed = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const entered = await prompt(rlConfirm, `Enter the pairing code from Telegram: `);
    if (entered.trim().toLowerCase() === pairingCode) {
      confirmed = true;
      break;
    }
    if (attempt < 3) {
      console.log(`  Incorrect code. ${3 - attempt} attempt(s) remaining.`);
    }
  }
  rlConfirm.close();

  if (!confirmed) {
    console.error('\n  Pairing code mismatch after 3 attempts. Aborting.');
    process.exit(1);
  }

  // Write access.json with user in allowlist
  const accessFile = path.join(telegramStateDir, 'access.json');
  const access: AccessJson = {
    dmPolicy: 'allowlist',
    allowFrom: [senderId],
    groups: {},
    pending: {},
  };
  fs.writeFileSync(accessFile, JSON.stringify(access, null, 2), 'utf8');

  // Send "Paired!" confirmation to Telegram
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await httpsPost(url, JSON.stringify({ chat_id: chatId, text: 'Paired! Say hi to Claude.' }));
  } catch {
    // Not fatal
  }

  console.log(`  ✓ Pairing approved — @${botUsername} is connected to your Telegram account`);
  return chatId;
}

// ---------------------------------------------------------------------------
// Step 6 — Welcome message + summary
// ---------------------------------------------------------------------------

function httpsPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendWelcome(token: string, chatId: string, agentName: string, wsDir: string): Promise<void> {
  const claudeMdPath = path.join(wsDir, 'CLAUDE.md');
  const userMessage = `Write a short, warm welcome message (2-3 sentences) to your new user, speaking fully in character. Do not use markdown formatting. End with a note telling the user that the gateway needs to be restarted once to activate this agent, and that you will be ready after that.`;

  const result = spawnSync(
    'claude',
    ['--print', '--system-prompt-file', claudeMdPath],
    {
      input: userMessage,
      encoding: 'utf8',
      timeout: 30000,
    },
  );

  const welcomeText =
    result.error || result.status !== 0 || !result.stdout?.trim()
      ? `Hello! I'm ${agentName}, your new assistant. I'm ready to help you. Just send me a message to get started!`
      : result.stdout.trim();

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await httpsPost(url, JSON.stringify({ chat_id: chatId, text: welcomeText }));
  } catch (err) {
    console.log(`  Warning: Could not send welcome message: ${(err as Error).message}`);
  }
}

function printSummary(agentId: string, botUsername: string): void {
  const wsDir = workspaceDir(agentId).replace(os.homedir(), '~');
  const cfgPath = configPath().replace(os.homedir(), '~');

  console.log('\nStep 6/6 · Done!\n');
  console.log('═══════════════════════════════════════');
  console.log(`  ✓ Agent "${agentId}" is ready!`);
  console.log('═══════════════════════════════════════\n');
  console.log(`Workspace:  ${wsDir}/`);
  console.log(`Config:     ${cfgPath}`);
  console.log('\nYour agent just introduced itself in Telegram.\n');
  console.log('To start the full gateway (all agents):');
  console.log(`  GATEWAY_CONFIG=${cfgPath} npm start\n`);
  console.log('To edit your agent\'s personality later, modify:');
  console.log(`  ${wsDir}/agent.md`);
  console.log(`  ${wsDir}/soul.md`);
  console.log('\nTo add new users to this agent later:');
  console.log(`  1. Change dmPolicy to pairing (if currently allowlist):`);
  console.log(`       edit ${wsDir}/.telegram-state/access.json → set "dmPolicy": "pairing"`);
  console.log(`  2. Ask the user to DM @${botUsername} — they'll get a pairing code`);
  console.log(`  3. Run: npm run pair -- --agent=${agentId} --code=<code>`);
  console.log('═══════════════════════════════════════');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ── Check for incomplete wizard state ─────────────────────────────────────
  const savedState = loadWizardState();
  if (savedState && savedState.lastCompletedStep < 6) {
    console.log('═══════════════════════════════════════');
    console.log('  Claude Gateway — Create New Agent');
    console.log('═══════════════════════════════════════\n');
    console.log(`  Found incomplete wizard for agent "${savedState.agentId}"`);
    console.log(`  Last completed step: ${savedState.lastCompletedStep}/6\n`);

    const rlResume = createRl();
    const resumeAnswer = await prompt(rlResume, 'Resume from where you left off? (y/n) [y]: ');
    rlResume.close();

    if (resumeAnswer.trim().toLowerCase() === 'n') {
      clearWizardState();
      console.log('Starting fresh...\n');
    } else {
      // Resume from saved state
      await resumeWizard(savedState);
      return;
    }
  }

  // ── Fresh start ────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════');
  console.log('  Claude Gateway — Create New Agent');
  console.log('═══════════════════════════════════════\n');

  const existingConfig = loadOrCreateRawConfig();
  const existingIds = existingConfig.agents.map((a) => a.id);

  const rl = createRl();

  // ── Step 1 ──────────────────────────────────────────────────────────────
  console.log('Step 1/6 · Agent Name\n');
  const agentId = await promptAgentName(rl, existingIds);
  const agentName = agentId.charAt(0).toUpperCase() + agentId.slice(1);

  const state: WizardState = { agentId, agentName, lastCompletedStep: 1 };
  saveWizardState(state);

  // ── Step 2 ──────────────────────────────────────────────────────────────
  console.log('\nStep 2/6 · Describe Your Agent\n');
  const description = await promptDescription(rl);
  rl.close(); // close rl before interactiveSelect (uses raw stdin)

  const { files: generatedFiles, suggestedEmoji } = await generateFiles(agentId, description);

  // ── Emoji selection (after generation) ────────────────────────────────
  // interactiveSelect pauses stdin — resume before creating new readline
  process.stdin.resume();

  const defaultEmoji = suggestedEmoji || '🤖';
  console.log(`\n  Suggested signature emoji: ${defaultEmoji}`);
  const rl2 = createRl();
  const emojiInput = await prompt(
    rl2,
    `Signature emoji [${defaultEmoji}] (press Enter to accept, or type a new one): `
  );
  const signatureEmoji = emojiInput.trim() || defaultEmoji;
  console.log(`  ✓ Signature emoji: ${signatureEmoji}`);
  rl2.close();

  // ── Reaction mode selection ───────────────────────────────────────────
  const reactionModes = ['minimal — react only when clearly warranted', 'extensive — react to most messages', 'none — no emoji reactions'];
  const modeIdx = await interactiveSelect(reactionModes, 'Select emoji reaction mode (↑/↓ to move, Enter to select):');
  const emojiReactionMode = (['minimal', 'extensive', 'none'] as const)[modeIdx];
  console.log(`  ✓ Reaction mode: ${emojiReactionMode}`);

  // Resume stdin + new readline for file preview
  process.stdin.resume();
  const rl3 = createRl();
  const acceptedFiles = await previewAndAccept(rl3, generatedFiles);

  if (!acceptedFiles.has('agent.md')) {
    const fallback = fallbackFiles(agentId);
    acceptedFiles.set('agent.md', fallback.get('agent.md')!);
  }
  state.lastCompletedStep = 2;
  saveWizardState(state);

  // ── Step 3 ──────────────────────────────────────────────────────────────
  console.log('\nStep 3/6 · Create Workspace\n');
  const wsDir = await createWorkspace(agentId, acceptedFiles);
  await appendToConfig(agentId, wsDir, acceptedFiles.get('agent.md')!, {
    emojiReactionMode,
    signatureEmoji,
  });
  state.wsDir = wsDir;
  state.lastCompletedStep = 3;
  saveWizardState(state);

  // ── Step 4 ──────────────────────────────────────────────────────────────
  console.log('\nStep 4/6 · Create a Telegram Bot\n');
  console.log('Follow these steps in Telegram:\n');
  console.log('  1. Open Telegram and search for @BotFather');
  console.log('  2. Send:  /newbot');
  console.log(`  3. Enter a display name (e.g. "${agentName} Assistant")`);
  console.log(`  4. Enter a unique username ending in "bot" (e.g. "${agentId}_my_bot")`);
  console.log('  5. BotFather will reply with a token like:');
  console.log('       123456789:AAHfiqksKZ8WmHPDKxxxxxxxxxxxxxxxx');
  console.log('     Copy the entire token.\n');

  const { token, username: botUsername } = await promptBotToken(rl3, agentId);
  state.token = token;
  state.botUsername = botUsername;
  state.lastCompletedStep = 4;
  saveWizardState(state);

  // ── Step 5 ──────────────────────────────────────────────────────────────
  rl3.close();

  console.log('\nStep 5/6 · Pair Your Telegram Account\n');
  console.log('The wizard will detect your message and approve pairing automatically.\n');
  const chatId = await startAndPair(agentId, token, wsDir, botUsername);
  state.chatId = chatId;
  state.lastCompletedStep = 5;
  saveWizardState(state);

  // ── Step 6 ──────────────────────────────────────────────────────────────
  console.log('\nGenerating welcome message...');
  await sendWelcome(token, chatId, agentName, wsDir);
  printSummary(agentId, botUsername);

  clearWizardState(); // Clean up on success
}

async function resumeWizard(state: WizardState): Promise<void> {
  const { agentId, agentName, lastCompletedStep } = state;
  console.log(`\nResuming "${agentId}" from step ${lastCompletedStep + 1}...\n`);

  const rl = createRl();

  if (lastCompletedStep < 2) {
    // Need to redo step 2 — files not yet created
    console.log('Step 2/6 · Describe Your Agent\n');
    const description = await promptDescription(rl);
    const { files: generatedFiles } = await generateFiles(agentId, description);
    const acceptedFiles = await previewAndAccept(rl, generatedFiles);
    if (!acceptedFiles.has('agent.md')) {
      acceptedFiles.set('agent.md', fallbackFiles(agentId).get('agent.md')!);
    }
    state.lastCompletedStep = 2;
    saveWizardState(state);

    console.log('\nStep 3/6 · Create Workspace\n');
    const wsDir = await createWorkspace(agentId, acceptedFiles);
    await appendToConfig(agentId, wsDir, acceptedFiles.get('agent.md')!);
    state.wsDir = wsDir;
    state.lastCompletedStep = 3;
    saveWizardState(state);
  }

  const wsDir = state.wsDir!;

  if (lastCompletedStep < 4) {
    console.log('Step 4/6 · Create a Telegram Bot\n');
    console.log('Follow these steps in Telegram:\n');
    console.log('  1. Open Telegram and search for @BotFather');
    console.log('  2. Send:  /newbot');
    console.log(`  3. Enter a display name (e.g. "${agentName} Assistant")`);
    console.log(`  4. Enter a unique username ending in "bot" (e.g. "${agentId}_my_bot")`);
    console.log('  5. Copy the token BotFather provides.\n');

    const { token, username: botUsername } = await promptBotToken(rl, agentId);
    state.token = token;
    state.botUsername = botUsername;
    state.lastCompletedStep = 4;
    saveWizardState(state);
  }

  const token = state.token!;
  const botUsername = state.botUsername!;

  rl.close();

  if (lastCompletedStep < 5) {
    console.log('Step 5/6 · Pair Your Telegram Account\n');
    console.log('The wizard will detect your message and approve pairing automatically.\n');
    const chatId = await startAndPair(agentId, token, wsDir, botUsername);
    state.chatId = chatId;
    state.lastCompletedStep = 5;
    saveWizardState(state);
  }

  const chatId = state.chatId!;

  console.log('\nGenerating welcome message...');
  await sendWelcome(token, chatId, agentName, wsDir);
  printSummary(agentId, botUsername);
  clearWizardState();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nFatal error:', (err as Error).message);
    process.exit(1);
  });
}
