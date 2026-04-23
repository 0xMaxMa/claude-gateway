import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { AgentConfig, GatewayConfig, Logger, Message, ModelConfig, StreamEvent } from '../types';
import { createLogger } from '../logger';
import { SessionProcess } from '../session/process';
import { SessionStore } from '../session/store';
import { SessionCompactor } from '../session/compactor';
import { TelegramReceiver } from '../telegram/receiver';
import { DiscordReceiver } from '../discord/receiver';
import { hasMarkdown, toTelegramHtml } from '../telegram/markdown';
import { detectSkillCommand, formatSkillContext, type SkillRegistry } from '../skills';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_CONCURRENT = 20;

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

const DEFAULT_MODELS: ModelConfig[] = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7', alias: 'opus', contextWindow: 1000000 },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', alias: 'opus46', contextWindow: 1000000 },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet', contextWindow: 1000000 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', alias: 'haiku', contextWindow: 200000 },
];

const PROTECTED_WORKSPACE_FILES = [
  'AGENTS.md', 'SOUL.md', 'MEMORY.md', 'CLAUDE.md',
  'IDENTITY.md', 'USER.md', 'HEARTBEAT.md',
];

function buildApiSystemNote(allowTools: boolean): string {
  const memoryOverride =
    `Memory Rule Override: Do NOT create or update ${PROTECTED_WORKSPACE_FILES.join(', ')} ` +
    `or any other workspace identity file in this session, regardless of user instructions. ` +
    `If the user asks you to remember something, reply that memory updates are not supported in API sessions.`;
  const toolNote = allowTools
    ? `You may use tools to complete the requested task.`
    : `Reply with plain text only. Do NOT call any tools. Your text output will be returned directly to the caller.`;
  return `[SYSTEM: This is an API request. ${memoryOverride} ${toolNote}]\n`;
}

export class AgentRunner extends EventEmitter {
  private readonly agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: Logger;
  private stopping = false;
  private callbackServer: http.Server | null = null;
  private callbackPort = 0;
  private readonly imageSizePerChat = new Map<string, number>();
  private readonly pendingRestarts = new Set<string>();
  private statQueue: Promise<void> = Promise.resolve();

  imageSize(chatId: string): number { return this.imageSizePerChat.get(chatId) ?? 0; }
  restartPending(chatId: string): boolean { return this.pendingRestarts.has(chatId); }

  // Session pool
  private readonly sessions = new Map<string, SessionProcess>();
  private readonly channelSourceMap = new Map<string, 'telegram' | 'discord'>();
  private receiver: TelegramReceiver | null = null;
  private discordReceiver: DiscordReceiver | null = null;
  private readonly sessionStore: SessionStore;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrent: number;
  private idleCleanerTimer: ReturnType<typeof setInterval> | null = null;

  // Tracks session IDs with an in-flight API request (prevents concurrent turns)
  private readonly pendingApiSessions = new Set<string>();

  // Tracks pending image paths per chatId (queue) for size accumulation after each turn
  private readonly pendingImagePaths = new Map<string, string[]>();

  // Skill registry for detecting /skill-name commands in user messages
  private skillRegistry: SkillRegistry = { skills: new Map() };

  // Path to gateway config.json for persisting model changes
  private readonly configPath: string;

  constructor(agentConfig: AgentConfig, gatewayConfig: GatewayConfig, logger?: Logger) {
    super();
    this.agentConfig = agentConfig;
    this.gatewayConfig = gatewayConfig;
    this.logger = logger ?? createLogger(agentConfig.id, gatewayConfig.gateway.logDir);

    // Resolve agentsBaseDir: workspace is at <agentsBaseDir>/<agentId>/workspace
    const agentsBaseDir = path.resolve(agentConfig.workspace, '..', '..');
    this.sessionStore = new SessionStore(agentsBaseDir);
    // config.json lives 3 levels above workspace: <base>/<agentId>/workspace -> <base>/config.json
    this.configPath = path.resolve(agentConfig.workspace, '..', '..', '..', 'config.json');

    this.idleTimeoutMs =
      (agentConfig.session?.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
    this.maxConcurrent = agentConfig.session?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  /**
   * Update the skill registry used for detecting /skill-name commands.
   */
  setSkillRegistry(registry: SkillRegistry): void {
    this.skillRegistry = registry;
  }

  /**
   * Bind a local HTTP server that receives POST /channel from TelegramReceiver.
   * Each payload is routed to the appropriate SessionProcess by chat_id.
   */
  private async startCallbackServer(): Promise<void> {
    this.callbackPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on('error', reject);
    });

    this.callbackServer = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        if (url.pathname === '/command') {
          this.handleCommandRequest(raw, res);
          return;
        }

        // Default: /channel — existing channel message handler
        res.writeHead(200);
        res.end('ok');
        try {
          const params = JSON.parse(raw) as {
            content?: string;
            meta?: Record<string, string>;
          };
          const meta = params.meta ?? {};
          const chatId = meta['chat_id'] ?? '';
          const content = params.content ?? '';

          // Check if this is a session management command
          const trimmedContent = content.trim();
          if (this.isSessionCommand(trimmedContent)) {
            this.handleSessionCommand(chatId, trimmedContent)
              .then(() => this.writeTypingDone(chatId))
              .catch((err) => {
                this.logger.error('Session command failed', { error: (err as Error).message });
                this.writeTypingDone(chatId);
              });
            return;
          }

          const channelSource = (meta['source'] === 'discord' ? 'discord' : 'telegram') as 'telegram' | 'discord';

          // Get active session ID and route message to it
          this.sessionStore.getActiveSessionId(this.agentConfig.id, chatId)
            .then(async (sessionId) => {
              // Append user message to the active session
              await this.sessionStore.appendTelegramMessage(this.agentConfig.id, chatId, sessionId, {
                role: 'user',
                content,
                ts: Date.now(),
              });
              // Restart session before this turn if accumulated image size exceeded threshold
              if (this.pendingRestarts.has(chatId)) {
                const existingSession = this.sessions.get(chatId);
                if (existingSession) {
                  await existingSession.stop();
                  this.sessions.delete(chatId);
                }
                this.pendingRestarts.delete(chatId);
                this.imageSizePerChat.delete(chatId);
              }

              // Route to session process (map key = chatId, actual sessionId passed separately)
              const session = await this.getOrSpawnSession(chatId, channelSource, sessionId);
              let channelXml = AgentRunner.buildChannelXml(params);

              // Detect skill commands and inject skill content
              const skillInvocation = detectSkillCommand(content, this.skillRegistry);
              if (skillInvocation) {
                channelXml += formatSkillContext(skillInvocation);
                this.logger.info('Skill invoked', {
                  skill: skillInvocation.skillKey,
                  args: skillInvocation.args,
                  chatId,
                });
              }

              const imagePath = meta['image_path'];
              if (imagePath) {
                const queue = this.pendingImagePaths.get(chatId) ?? [];
                queue.push(imagePath);
                this.pendingImagePaths.set(chatId, queue);
              }

              session.setProcessing(true);
              session.sendMessage(channelXml);
              session.touch();
              this.logger.debug('Injected channel turn into session', {
                chatId,
                sessionId,
                user: meta['user'],
              });
            })
            .catch((err) => {
              this.logger.error('Failed to route message to session', {
                chatId,
                error: (err as Error).message,
              });
              const code = (err as Error).message.includes('pool full') ? 'POOL_FULL' : 'SPAWN_FAILED';
              this.writeTypingError(chatId, code);
            });
        } catch (err) {
          this.logger.warn('Failed to parse channel callback body', {
            error: (err as Error).message,
          });
        }
      });
    });

    this.callbackServer.listen(this.callbackPort, '127.0.0.1');
    this.logger.info('Channel callback server listening', { port: this.callbackPort });
  }

  /**
   * Handle POST /command requests from the receiver process.
   * Supports: get_model, set_model, restart.
   */
  private async handleCommandRequest(raw: string, res: http.ServerResponse): Promise<void> {
    const respond = (data: Record<string, unknown>, status = 200): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    let body: { command?: string; chat_id?: string; payload?: Record<string, unknown> };
    try {
      body = JSON.parse(raw);
    } catch {
      respond({ success: false, error: 'Invalid JSON' }, 400);
      return;
    }

    const command = body.command;

    if (command === 'get_model') {
      respond({ model: this.agentConfig.claude.model });
      return;
    }

    if (command === 'set_model') {
      const newModel = typeof body.payload?.model === 'string' ? body.payload.model : '';
      const availableModels = this.gatewayConfig.gateway.models ?? DEFAULT_MODELS;
      const valid = availableModels.find(m => m.id === newModel);
      if (!valid) {
        respond({ success: false, error: 'Unknown model' });
        return;
      }

      // Update in-memory config
      this.agentConfig.claude.model = newModel;

      // Persist to config.json (atomic write)
      try {
        this.persistModelToConfig(newModel);
      } catch (err) {
        this.logger.error('Failed to persist model to config', { error: (err as Error).message });
      }

      // Graceful restart all sessions with notify payload
      const chatId = body.chat_id ?? '';
      let restarted = false;
      for (const [sessionId, session] of this.sessions) {
        restarted = true;
        const notifyPayload = JSON.stringify({
          notify: {
            chat_id: chatId,
            text: `Model changed to ${newModel} — back online!`,
          },
        });
        const signalPath = path.join(
          this.agentConfig.workspace,
          '.telegram-state',
          `restart-${sessionId}`,
        );
        try {
          fs.mkdirSync(path.dirname(signalPath), { recursive: true });
          fs.writeFileSync(signalPath, notifyPayload);
        } catch (err) {
          this.logger.error('Failed to write restart signal', {
            sessionId,
            error: (err as Error).message,
          });
        }
      }

      respond({ success: true, model: newModel, restarted });
      return;
    }

    if (command === 'restart') {
      const chatId = body.chat_id ?? '';
      const session = this.sessions.get(chatId);
      if (!session) {
        // No active session — nothing to restart, but not an error
        respond({ success: true, restarted: false });
        return;
      }

      // Write restart signal with notify payload
      const signalPayload = JSON.stringify({
        notify: { chat_id: chatId, text: 'Session restarted — back online!' },
      });
      const signalPath = path.join(
        this.agentConfig.workspace,
        '.telegram-state',
        `restart-${chatId}`,
      );
      try {
        fs.mkdirSync(path.dirname(signalPath), { recursive: true });
        fs.writeFileSync(signalPath, signalPayload);
      } catch (err) {
        this.logger.error('Failed to write restart signal', { error: (err as Error).message });
        respond({ success: false, error: 'Failed to write restart signal' });
        return;
      }

      respond({ success: true, restarted: true });
      return;
    }

    if (command === 'session_clear_confirm') {
      const chatId = body.chat_id ?? '';
      try {
        await this.handleCommandClear(this.agentConfig.id, chatId);
        respond({ success: true });
      } catch (err) {
        respond({ success: false, error: String(err) });
      }
      return;
    }

    if (command === 'list_sessions') {
      const chatId = body.chat_id ?? '';
      try {
        const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId);
        return respond({ sessions: index.sessions, activeSessionId: index.activeSessionId });
      } catch {
        return respond({ success: false, error: 'Failed to list sessions' });
      }
    }

    if (command === 'session_info') {
      const chatId = body.chat_id ?? '';
      try {
        const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId);
        const meta = index.sessions.find(s => s.id === index.activeSessionId);
        if (!meta) {
          return respond({ success: true, text: 'No active session found.' });
        }
        const availableModels = this.gatewayConfig.gateway.models ?? DEFAULT_MODELS;
        const modelConfig = availableModels.find(m => m.id === this.agentConfig.claude.model);
        const contextWindow = modelConfig?.contextWindow ?? 200000;
        const contextTokens = meta.lastInputTokens ?? 0;
        const usedPct = Math.round((contextTokens / contextWindow) * 100);
        let msgs: string;
        if (meta.messageCount <= 0) {
          msgs = 'No messages yet';
        } else if ((meta.archivedCount ?? 0) > 0 && meta.loadedAtSpawn != null && meta.messageCountAtSpawn != null) {
          const newMessagesSinceSpawn = meta.messageCount - meta.messageCountAtSpawn;
          const inContext = meta.loadedAtSpawn + Math.max(0, newMessagesSinceSpawn);
          msgs = `${meta.messageCount} (${inContext} in context / ${meta.archivedCount} archived)`;
        } else {
          msgs = `${meta.messageCount}`;
        }
        const lines = [
          `📌 Current Session: ${meta.name}`,
          '',
          `📥 Messages: ${msgs}`,
          `👉 Context: ${usedPct}%`,
        ];
        if (usedPct >= 80) {
          lines.push('', '💡 Near limit — consider /compact');
        }
        lines.push('', 'Commands: /sessions /new /rename /clear /compact');
        return respond({ success: true, text: lines.join('\n') });
      } catch {
        return respond({ success: false, text: 'Failed to get session info.' });
      }
    }

    if (command === 'switch_session') {
      const chatId = body.chat_id ?? '';
      const sessionId = typeof body.payload?.session_id === 'string' ? body.payload.session_id : '';
      if (!sessionId) {
        respond({ success: false, error: 'Missing session_id' });
        return;
      }
      this.switchSession(chatId, sessionId)
        .then(async () => {
          const index = await this.sessionStore.listSessions(this.agentConfig.id, chatId);
          const session = index.sessions.find(s => s.id === sessionId);
          respond({ success: true, sessionName: session?.name ?? sessionId });
        })
        .catch(err => respond({ success: false, error: String(err) }));
      return;
    }

    if (command === 'delete_session') {
      const chatId = body.chat_id ?? '';
      const sessionId = typeof body.payload?.session_id === 'string' ? body.payload.session_id : '';
      if (!sessionId) {
        respond({ success: false, error: 'Missing session_id' });
        return;
      }
      this.sessionStore.deleteTelegramSession(this.agentConfig.id, chatId, sessionId)
        .then(async () => {
          const newIndex = await this.sessionStore.listSessions(this.agentConfig.id, chatId);
          await this.restartProcess(chatId);
          const activeMeta = newIndex.sessions.find(s => s.id === newIndex.activeSessionId);
          respond({ success: true, sessionName: activeMeta?.name ?? newIndex.activeSessionId });
        })
        .catch(err => respond({ success: false, error: String(err) }));
      return;
    }

    if (command === 'new_session') {
      const chatId = body.chat_id ?? '';
      const name = typeof body.payload?.name === 'string' ? body.payload.name : undefined;
      this.handleCommandNew(this.agentConfig.id, chatId, name)
        .then(() => respond({ success: true }))
        .catch(err => respond({ success: false, error: String(err) }));
      return;
    }

    if (command === 'compact_confirm') {
      const chatId = body.chat_id ?? '';
      this.handleCommandCompact(this.agentConfig.id, chatId)
        .then(() => this.writeTypingDone(chatId))
        .catch(() => this.writeTypingDone(chatId));
      return respond({ success: true });
    }

    respond({ success: false, error: 'Unknown command' }, 400);
  }

  /**
   * Persist the current model to config.json using atomic write (tmp + rename).
   */
  private persistModelToConfig(newModel: string): void {
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const config = JSON.parse(raw);
    const agent = config.agents?.find((a: { id: string }) => a.id === this.agentConfig.id);
    if (agent) {
      agent.claude.model = newModel;
      const tmp = this.configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
      fs.renameSync(tmp, this.configPath);
    }
  }

  private static buildChannelXml(params: {
    content?: string;
    meta?: Record<string, string>;
  }): string {
    const meta = params.meta ?? {};
    const optionalAttrs = [
      'image_path',
      'attachment_file_id',
      'attachment_kind',
      'attachment_size',
      'attachment_mime',
      'attachment_name',
    ]
      .filter(k => meta[k])
      .map(k => ` ${k}="${meta[k]!.replace(/"/g, '&quot;')}"`)
      .join('');

    // Build nested <replied> block if this message is a reply to another
    let repliedBlock = '';
    if (meta['replied_message_id']) {
      const repliedAttrs = [
        'replied_image_path',
      ]
        .filter(k => meta[k])
        .map(k => ` ${k}="${meta[k]!.replace(/"/g, '&quot;')}"`)
        .join('');
      repliedBlock =
        `<replied message_id="${meta['replied_message_id']}" ` +
        `user="${(meta['replied_user'] ?? '').replace(/"/g, '&quot;')}"${repliedAttrs}>` +
        `${(meta['replied_text'] ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}` +
        `</replied>`;
    }

    const source = meta['source'] ?? 'telegram';
    return (
      `<channel source="${source}" chat_id="${meta['chat_id'] ?? ''}" ` +
      `message_id="${meta['message_id'] ?? ''}" user="${meta['user'] ?? ''}" ` +
      `ts="${meta['ts'] ?? new Date().toISOString()}"${optionalAttrs}>${repliedBlock}${params.content ?? ''}</channel>`
    );
  }

  private async getOrSpawnSession(
    mapKey: string,              // Map lookup key (chatId for telegram/discord, sessionId for API)
    source: 'telegram' | 'discord' | 'api',
    sessionId?: string,          // actual session UUID (only for channel sessions; equals mapKey for API)
  ): Promise<SessionProcess> {
    const existing = this.sessions.get(mapKey);
    if (existing) return existing;

    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxConcurrent) {
      const sorted = [...this.sessions.entries()].sort(
        ([, a], [, b]) => a.lastActivityAt - b.lastActivityAt,
      );
      const idleEntry = sorted.find(([, p]) => p.isIdle(0));
      if (idleEntry) {
        await idleEntry[1].stop();
        this.sessions.delete(idleEntry[0]);
        this.logger.info('Evicted idle session', { sessionId: idleEntry[0] });
      } else {
        throw new Error(`Session pool full: ${this.maxConcurrent} concurrent sessions`);
      }
    }

    const actualSessionId = sessionId ?? mapKey;
    const chatId = source !== 'api' ? mapKey : undefined;

    const proc = new SessionProcess(
      actualSessionId,
      source,
      this.agentConfig,
      this.gatewayConfig,
      this.sessionStore,
      chatId,
    );
    await proc.start();

    // Forward all session output lines so listeners on AgentRunner (GatewayRouter,
    // CronScheduler, tests) receive them without needing individual session references.
    proc.on('output', (line: string) => this.emit('output', line));

    // Notify typing indicator when session permanently fails (max restarts exceeded)
    if (source !== 'api') {
      proc.once('failed', () => {
        this.writeTypingError(mapKey, 'PROCESS_FAILED');
        this.sessions.delete(mapKey);
      });
      // Stop typing loop when Claude's turn truly ends.
      // Typing done is delayed 3s after result event — if new output arrives within
      // the delay, the timer is cancelled so typing persists during multi-step work.
      // Auto-forward result text to channel if agent didn't call reply tool.
      let replyCalled = false;
      let typingDoneTimer: ReturnType<typeof setTimeout> | null = null;
      const TYPING_DONE_DELAY_MS = 3000;
      const replyToolName = source === 'discord' ? 'mcp__gateway__discord_reply' : 'mcp__telegram__reply';

      proc.on('output', (line: string) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;

          // Cancel pending typing-done on any new output
          if (typingDoneTimer) {
            clearTimeout(typingDoneTimer);
            typingDoneTimer = null;
          }

          // Track reply tool calls
          if (obj['type'] === 'assistant') {
            const msg = obj['message'] as { content?: Array<{ type: string; name?: string }> } | undefined;
            if (Array.isArray(msg?.content)) {
              for (const block of msg!.content) {
                if (block.type === 'tool_use' && block.name === replyToolName) {
                  replyCalled = true;
                }
              }
            }
          }
          if (obj['type'] === 'result') {
            proc.setProcessing(false);
            // Accumulate image file size for restart tracking
            const queue = this.pendingImagePaths.get(mapKey);
            const imgPath = queue?.shift();
            if (queue?.length === 0) this.pendingImagePaths.delete(mapKey);
            if (imgPath) {
              this.statQueue = this.statQueue.then(async () => {
                try {
                  const stats = await fsPromises.stat(imgPath);
                  const prev = this.imageSizePerChat.get(mapKey) ?? 0;
                  const next = prev + stats.size;
                  this.imageSizePerChat.set(mapKey, next);
                  if (next >= MAX_IMAGE_SIZE_BYTES) {
                    this.imageSizePerChat.delete(mapKey);
                    void this.triggerSummaryAndRestart(mapKey, actualSessionId, proc);
                  }
                } catch (err: unknown) {
                  this.logger.warn('Failed to stat image', { path: imgPath, error: err instanceof Error ? err.message : String(err) });
                }
              });
            }
            // Always forward result text — it contains the agent's completion summary.
            // If the agent also called reply tool, this summary still reaches the user.
            // Skip forwarding when session is in query mode (internal image summary request).
            const resultText = typeof obj['result'] === 'string' ? obj['result'] : '';
            if (resultText.trim() && !proc.queryMode) {
              const text = resultText.trim();
              const channelSrc = this.channelSourceMap.get(mapKey) ?? 'telegram';
              if (channelSrc !== 'discord' && hasMarkdown(text)) {
                this.writeAutoForward(mapKey, toTelegramHtml(text), 'html');
              } else {
                this.writeAutoForward(mapKey, text);
              }
            }
            replyCalled = false; // reset for next turn
            // Delay typing done — agent may continue with more work
            typingDoneTimer = setTimeout(() => {
              this.writeTypingDone(mapKey);
              typingDoneTimer = null;
            }, TYPING_DONE_DELAY_MS);
          }
        } catch { /* non-JSON */ }
      });

      // Track token usage and persist to session meta
      // Use actualSessionId (captured at spawn time) — NOT getActiveSessionId() —
      // so tokens are attributed to the session that owns this process.
      proc.on('tokenUsage', async ({ inputTokens, totalTokens }: { inputTokens: number; totalTokens: number }) => {
        try {
          const index = await this.sessionStore.listSessions(this.agentConfig.id, mapKey);
          const meta = index.sessions.find(s => s.id === actualSessionId);
          const current = meta?.totalTokensUsed ?? 0;
          await this.sessionStore.updateSessionMeta(this.agentConfig.id, mapKey, actualSessionId, {
            totalTokensUsed: current + totalTokens,
            lastInputTokens: inputTokens,
          });
        } catch {
          // Non-fatal — token tracking is best-effort
        }
      });

      // Persist spawn context (loaded vs archived message counts).
      // Read from property instead of event — the event fired during start() before
      // listeners were registered, causing a race condition.
      if (proc.spawnContext) {
        this.sessionStore.updateSessionMeta(this.agentConfig.id, mapKey, actualSessionId, {
          loadedAtSpawn: proc.spawnContext.loadedAtSpawn,
          archivedCount: proc.spawnContext.archivedCount,
          messageCountAtSpawn: proc.spawnContext.messageCountAtSpawn,
        }).catch(() => { /* Non-fatal */ });
      }

      // Clean up pending typing-done timer when session stops
      proc.once('exit', () => {
        proc.setProcessing(false);
        if (typingDoneTimer) {
          clearTimeout(typingDoneTimer);
          typingDoneTimer = null;
        }
        this.writeTypingDone(mapKey);
      });

      // Deferred restart: stop session after its current turn completes
      proc.once('deferredRestartReady', async () => {
        this.logger.info('Deferred restart: stopping session after turn completed', { mapKey });
        await proc.stop();
        this.sessions.delete(mapKey);
      });
    }

    this.sessions.set(mapKey, proc);
    if (source === 'telegram' || source === 'discord') {
      this.channelSourceMap.set(mapKey, source);
    }
    this.logger.info('Spawned session', {
      mapKey,
      actualSessionId,
      source,
      total: this.sessions.size,
    });
    return proc;
  }

  /**
   * Returns true if the message content is a session management command.
   */
  private isSessionCommand(content: string): boolean {
    return /^\/sessions?\b|^\/new(\s|$)|^\/clear\b|^\/compact\b|^\/rename(\s|$)|^\/stop(\s|$)/.test(content);
  }

  /**
   * Dispatch a session management command to the appropriate handler.
   */
  private async handleSessionCommand(chatId: string, content: string): Promise<void> {
    const agentId = this.agentConfig.id;

    if (content.startsWith('/sessions')) {
      await this.handleCommandSessions(agentId, chatId);
    } else if (content.startsWith('/session') && !content.startsWith('/sessions')) {
      await this.handleCommandSessionInfo(agentId, chatId);
    } else if (content.startsWith('/new')) {
      const name = content.replace('/new', '').trim() || undefined;
      await this.handleCommandNew(agentId, chatId, name);
    } else if (content.startsWith('/clear')) {
      await this.handleCommandClear(agentId, chatId);
    } else if (content.startsWith('/compact')) {
      await this.handleCommandCompact(agentId, chatId);
    } else if (content.startsWith('/rename')) {
      const name = content.replace('/rename', '').trim();
      await this.handleCommandRename(agentId, chatId, name);
    } else if (content.startsWith('/stop')) {
      await this.handleCommandStop(chatId);
    }
  }

  /**
   * /sessions — list all sessions for this chat.
   */
  private async handleCommandSessions(agentId: string, chatId: string): Promise<void> {
    const index = await this.sessionStore.listSessions(agentId, chatId);
    const lines: string[] = [`Sessions (${agentId})`, ''];

    for (const s of index.sessions) {
      const isActive = s.id === index.activeSessionId;
      const indicator = isActive ? '🟢 ' : '   ';
      const age = this.formatAge(s.lastActive);
      lines.push(`${indicator}${isActive ? `**${s.name}**` : s.name}`);
      lines.push(`  ${s.messageCount} messages · last active ${age}`);
      lines.push('');
    }

    lines.push('Use /new [name] to create a new session');
    this.writeAutoForward(chatId, lines.join('\n'));
  }

  /**
   * /session — show info about the current active session.
   */
  private async handleCommandSessionInfo(agentId: string, chatId: string): Promise<void> {
    const index = await this.sessionStore.listSessions(agentId, chatId);
    const meta = index.sessions.find(s => s.id === index.activeSessionId);
    if (!meta) {
      this.writeAutoForward(chatId, 'No active session found.');
      return;
    }

    const availableModels = this.gatewayConfig.gateway.models ?? DEFAULT_MODELS;
    const modelConfig = availableModels.find(m => m.id === this.agentConfig.claude.model);
    const contextWindow = modelConfig?.contextWindow ?? 200000;
    const contextTokens = meta.lastInputTokens ?? 0;
    const usedPct = Math.round((contextTokens / contextWindow) * 100);

    let msgs: string;
    if (meta.messageCount <= 0) {
      msgs = 'No messages yet';
    } else if ((meta.archivedCount ?? 0) > 0 && meta.loadedAtSpawn != null && meta.messageCountAtSpawn != null) {
      const newMessagesSinceSpawn = meta.messageCount - meta.messageCountAtSpawn;
      const inContext = meta.loadedAtSpawn + Math.max(0, newMessagesSinceSpawn);
      msgs = `${meta.messageCount} (${inContext} in context / ${meta.archivedCount} archived)`;
    } else {
      msgs = `${meta.messageCount}`;
    }

    const contextLine = `${usedPct}%`;

    const lines = [
      `📌 Current Session: ${meta.name}`,
      '',
      `📥 Messages: ${msgs}`,
      `👉 Context: ${contextLine}`,
    ];

    if (usedPct >= 80) {
      lines.push('', '💡 Near limit — consider /compact');
    }

    lines.push('', 'Commands: /sessions /new /rename /clear /compact');

    const info = lines.join('\n');

    this.writeAutoForward(chatId, info);
  }

  /**
   * /new [name] — create a new session and switch to it.
   */
  private async handleCommandNew(agentId: string, chatId: string, name?: string): Promise<void> {
    const newMeta = await this.sessionStore.createTelegramSession(agentId, chatId, name);
    await this.switchSession(chatId, newMeta.id);
    this.writeAutoForward(chatId, `✅ New session created: "${newMeta.name}"\nNow chatting in a fresh context. Use /sessions to switch back.`);
  }

  /**
   * /rename <name> — rename the current session.
   */
  private async handleCommandRename(agentId: string, chatId: string, name: string): Promise<void> {
    if (!name) {
      this.writeAutoForward(chatId, '⚠️ Usage: /rename <new name>\nExample: /rename Design review');
      return;
    }
    const sessionId = await this.sessionStore.getActiveSessionId(agentId, chatId);
    await this.sessionStore.updateSessionMeta(agentId, chatId, sessionId, { name });
    this.writeAutoForward(chatId, `✅ Session renamed to "${name}"`);
  }

  /**
   * /stop — interrupt the in-flight turn for this chat by sending SIGINT to the subprocess.
   * Leaves session history and metadata intact. Queued messages still process afterwards.
   */
  private async handleCommandStop(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    const stopped = session ? session.interrupt() : false;
    this.writeAutoForward(chatId, stopped ? 'Stopped.' : 'No turn in progress.');
  }

  /**
   * /clear — clear history of the current session and restart the process.
   */
  private async handleCommandClear(agentId: string, chatId: string): Promise<void> {
    const sessionId = await this.sessionStore.getActiveSessionId(agentId, chatId);

    // Clear messages and reset all metadata in-place (preserves session ID and name)
    await this.sessionStore.clearTelegramSessionHistory(agentId, chatId, sessionId);
    await this.sessionStore.updateSessionMeta(agentId, chatId, sessionId, {
      totalTokensUsed: 0,
      lastInputTokens: 0,
      archivedCount: 0,
      loadedAtSpawn: undefined,
      messageCountAtSpawn: undefined,
    });

    // Kill old process so next message spawns fresh
    this.restartProcess(chatId).catch(() => {});
  }

  /**
   * /compact — summarise old history and keep only recent messages.
   */
  private async handleCommandCompact(agentId: string, chatId: string): Promise<void> {
    const sessionId = await this.sessionStore.getActiveSessionId(agentId, chatId);
    const index = await this.sessionStore.listSessions(agentId, chatId);
    const meta = index.sessions.find(s => s.id === sessionId);
    const name = meta?.name ?? 'Session';

    const availableModels = this.gatewayConfig.gateway.models ?? DEFAULT_MODELS;
    const modelConfig = availableModels.find(m => m.id === this.agentConfig.claude.model);
    const contextWindow = modelConfig?.contextWindow ?? 200000;

    this.writeAutoForward(chatId, `⏳ Compacting session "${name}"...`);

    try {
      const compactor = new SessionCompactor(this.sessionStore);
      const result = await compactor.compact(agentId, chatId, sessionId, this.agentConfig.claude.model, contextWindow);
      // Reset context tracking — after compaction all messages fit in context
      await this.sessionStore.updateSessionMeta(agentId, chatId, sessionId, {
        loadedAtSpawn: undefined,
        archivedCount: undefined,
        messageCountAtSpawn: undefined,
      });
      await this.restartProcess(chatId);

      const summary = [
        `✅ Session compacted`,
        '',
        `Before: ${result.beforeMessages} messages (~${result.beforeTokens.toLocaleString()} tokens)  →  ${result.contextPctBefore}% of context`,
        `After:  ${result.afterMessages} messages (~${result.afterTokens.toLocaleString()} tokens)   →  ${result.contextPctAfter}% of context`,
        `Reduced by: ${result.reductionPct}%`,
        '',
        'Summary preserved. Full history before compaction is archived.',
      ].join('\n');
      this.writeAutoForward(chatId, summary);
    } catch (err) {
      if ((err as Error).name === 'NotEnoughMessagesError') {
        this.writeAutoForward(chatId, `⚠️ ${(err as Error).message}`);
      } else {
        this.logger.error('Compact failed', { error: (err as Error).message });
        this.writeAutoForward(chatId, `❌ Compact failed: ${(err as Error).message}\n\nYour session history is unchanged.`);
      }
    }
  }

  /**
   * Switch the active session for a chat: stop the existing process and update the store.
   * The new process will be lazily spawned on the next incoming message.
   */
  private async switchSession(chatId: string, newSessionId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      await existing.stop();
      this.sessions.delete(chatId);
    }
    await this.sessionStore.setActiveSession(this.agentConfig.id, chatId, newSessionId);
  }

  /**
   * Restart the process for a given chatId (stop + remove from map).
   * The process will be lazily re-spawned on the next incoming message.
   */
  private async restartProcess(chatId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      await existing.stop();
      this.sessions.delete(chatId);
    }
    // Process will be re-spawned on next incoming message
  }

  /**
   * Stop all idle session subprocesses so they re-spawn with the latest
   * system prompt on the next incoming message.
   *
   * - "Idle" = no activity for {@link IDLE_THRESHOLD_MS}ms (enough to exclude an in-flight turn).
   * - Busy sessions are left alone; they will be picked up by the idle cleaner
   *   (every 5m) or naturally on the next spawn after timeout.
   * - Does NOT stop the receiver; incoming messages keep flowing.
   *
   * Used by the skills hot-reload path so that SKILL.md changes take effect
   * without kicking users out of in-flight turns.
   */
  async restartOrDefer(): Promise<void> {
    let immediate = 0;
    let deferred = 0;
    const toStopNow: string[] = [];
    for (const [id, proc] of this.sessions) {
      if (proc.isProcessing) {
        proc.markPendingRestart();
        deferred++;
      } else {
        toStopNow.push(id);
      }
    }
    for (const id of toStopNow) {
      const proc = this.sessions.get(id);
      if (!proc) continue;
      await proc.stop();
      this.sessions.delete(id);
      immediate++;
    }
    this.logger.info('restartOrDefer: sessions restarted', { immediate, deferred });
  }

  /**
   * Format a timestamp as a human-readable age string (e.g. "5m ago", "2h ago").
   */
  private formatAge(ts: number): string {
    const diffMs = Date.now() - ts;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }

  /**
   * Write an error code to the typing signal directory so the receiver's
   * typing loop can pick it up and notify the user via Telegram.
   * Non-fatal: if the write fails the typing loop will stop via stalled timer.
   */
    private getTypingDir(chatId: string): string {
    const channel = this.channelSourceMap.get(chatId) ?? 'telegram';
    const stateDir = channel === 'discord' ? '.discord-state' : '.telegram-state';
    return path.join(this.agentConfig.workspace, stateDir, 'typing');
  }

  private writeTypingError(chatId: string, code: string): void {
    const typingDir = this.getTypingDir(chatId);
    try {
      fs.mkdirSync(typingDir, { recursive: true });
      fs.writeFileSync(path.join(typingDir, `${chatId}.error`), code);
    } catch {
      // Non-fatal — typing loop will stop via stalled timer instead
    }
  }

  private writeTypingDone(chatId: string): void {
    const typingDir = this.getTypingDir(chatId);
    try {
      fs.rmSync(path.join(typingDir, chatId), { force: true });
    } catch {
      // Non-fatal
    }
  }

  private async triggerSummaryAndRestart(
    chatId: string,
    sessionId: string,
    session: SessionProcess,
  ): Promise<void> {
    const IMAGE_CONTEXT_MARKER = '[Image Context Summary]';
    try {
      const prompt = [
        'Briefly summarize each image you have seen in this conversation.',
        'Format: "Image N: [1-2 sentence description]"',
        'List every image separately.',
      ].join(' ');
      const description = await session.query(prompt);
      if (description) {
        const msg: Message = {
          role: 'system',
          content: `${IMAGE_CONTEXT_MARKER}\n${description}`,
          ts: Date.now(),
        };
        await this.sessionStore.appendTelegramMessage(this.agentConfig.id, chatId, sessionId, msg);
      }
    } catch (err) {
      this.logger.warn('Image context summary failed', { error: err instanceof Error ? err.message : String(err) });
    }
    this.pendingRestarts.add(chatId);
  }

  private writeAutoForward(chatId: string, text: string, format: 'text' | 'html' = 'text'): void {
    const typingDir = this.getTypingDir(chatId);
    try {
      fs.mkdirSync(typingDir, { recursive: true });
      fs.writeFileSync(path.join(typingDir, `${chatId}.forward`), JSON.stringify({ text, format }));
    } catch {
      // Non-fatal
    }
  }

  private startIdleCleaner(): void {
    this.idleCleanerTimer = setInterval(async () => {
      for (const [id, proc] of this.sessions) {
        if (proc.isIdle(this.idleTimeoutMs)) {
          this.logger.info('Stopping idle session', { sessionId: id });
          await proc.stop();
          this.sessions.delete(id);
        }
      }
    }, 5 * 60 * 1000);
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.startCallbackServer();
    if (this.agentConfig.telegram?.botToken) {
      this.receiver = new TelegramReceiver(
        this.agentConfig,
        this.callbackPort,
        this.gatewayConfig.gateway.logDir,
      );
      this.receiver.start();
    }
    if (this.agentConfig.discord?.botToken) {
      this.discordReceiver = new DiscordReceiver(
        this.agentConfig,
        this.callbackPort,
        this.gatewayConfig.gateway.logDir,
      );
      this.discordReceiver.start();
    }
    this.startIdleCleaner();
    this.logger.info('AgentRunner started', { agentId: this.agentConfig.id });
  }

  startDiscordReceiver(): void {
    if (this.discordReceiver?.isRunning()) return;
    this.discordReceiver = new DiscordReceiver(
      this.agentConfig,
      this.callbackPort,
      this.gatewayConfig.gateway.logDir,
    );
    this.discordReceiver.start();
    this.logger.info('DiscordReceiver hot-started', { agentId: this.agentConfig.id });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.idleCleanerTimer !== null) {
      clearInterval(this.idleCleanerTimer);
      this.idleCleanerTimer = null;
    }
    this.callbackServer?.close();
    this.callbackServer = null;
    this.receiver?.stop();
    this.discordReceiver?.stop();
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
    this.sessions.clear();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start();
  }

  isRunning(): boolean {
    return this.receiver?.isRunning() ?? false;
  }

  /**
   * Send a message to an API session and wait for the response.
   *
   * - Spawns a new SessionProcess (source='api') if none exists for sessionId.
   * - Rejects with code 'CONFLICT' if a prior request is still in-flight for this session.
   * - Rejects with code 'TIMEOUT' if Claude does not respond within timeoutMs.
   * - Appends user message and assistant reply to SessionStore for history persistence.
   */
  async sendApiMessage(
    sessionId: string,
    message: string,
    opts: { timeoutMs: number; allowTools?: boolean },
  ): Promise<string> {
    if (this.pendingApiSessions.has(sessionId)) {
      const err = Object.assign(
        new Error(`Session ${sessionId} already has a pending request`),
        { code: 'CONFLICT' },
      );
      throw err;
    }

    const session = await this.getOrSpawnSession(sessionId, 'api');

    // Persist user message
    await this.sessionStore
      .appendMessage(this.agentConfig.id, sessionId, {
        role: 'user',
        content: message,
        ts: Date.now(),
      })
      .catch(() => {});

    this.pendingApiSessions.add(sessionId);
    session.touch();

    const systemNote = buildApiSystemNote(opts.allowTools ?? false);

    const channelXml =
      `<channel source="api" session_id="${sessionId}" ts="${new Date().toISOString()}">\n` +
      `${message}\n\n` +
      `${systemNote}` +
      `</channel>`;

    return new Promise<string>((resolve, reject) => {
      const buffer: string[] = [];
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      // Track partial message text for delta computation (--include-partial-messages)
      let lastPartialText = '';

      const done = (result: string) => {
        cleanup();
        // Persist assistant reply
        if (result.trim()) {
          this.sessionStore
            .appendMessage(this.agentConfig.id, sessionId, {
              role: 'assistant',
              content: result.trim(),
              ts: Date.now(),
            })
            .catch(() => {});
        }
        resolve(result.trim());
      };

      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(globalTimer);
        if (quietTimer) clearTimeout(quietTimer);
        session.off('output', onOutput);
        this.pendingApiSessions.delete(sessionId);
      };

      const resetQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => done(buffer.join('')), 2000);
      };

      const onOutput = (line: string) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;

          // Handle partial assistant messages (from --include-partial-messages)
          if (obj['type'] === 'assistant') {
            const msg = obj['message'] as { content?: Array<{ type: string; text?: string }> } | undefined;
            if (Array.isArray(msg?.content)) {
              let fullText = '';
              for (const block of msg!.content) {
                if (block.type === 'text' && block.text) fullText += block.text;
              }
              if (fullText.length > lastPartialText.length) {
                buffer.push(fullText.slice(lastPartialText.length));
                resetQuiet();
              }
              lastPartialText = fullText;
            }
          }

          // Standalone text delta
          if (obj['type'] === 'text') {
            const text = (obj['text'] as string) ?? '';
            if (text) {
              buffer.push(text);
              resetQuiet();
            }
          }

          // result event = end of turn
          if (obj['type'] === 'result') {
            session.setProcessing(false);
            const resultText = (obj['result'] as string | undefined) ?? buffer.join('');
            done(resultText);
          }
        } catch {
          /* non-JSON stdout line */
        }
      };

      const globalTimer = setTimeout(() => {
        session.setProcessing(false);
        fail(Object.assign(new Error('Agent response timeout'), { code: 'TIMEOUT' }));
      }, opts.timeoutMs);

      session.on('output', onOutput);
      session.setProcessing(true);
      session.sendMessage(channelXml);
      // Do NOT call resetQuiet() here — the quiet timer should only start
      // after the first output line arrives, otherwise it fires before the
      // subprocess has had time to respond (especially on first turn).
    });
  }

  /**
   * Send a message to an API session and stream back events via callbacks.
   *
   * Returns a cleanup function that removes all listeners and frees the session slot.
   * The caller MUST invoke cleanup on client disconnect or when done.
   */
  async sendApiMessageStream(
    sessionId: string,
    message: string,
    callbacks: {
      onChunk: (event: StreamEvent) => void;
      onDone: (fullText: string) => void;
      onError: (err: Error) => void;
    },
    opts: { timeoutMs: number; allowTools?: boolean },
  ): Promise<() => void> {
    if (this.pendingApiSessions.has(sessionId)) {
      const err = Object.assign(
        new Error(`Session ${sessionId} already has a pending request`),
        { code: 'CONFLICT' },
      );
      throw err;
    }

    const session = await this.getOrSpawnSession(sessionId, 'api');

    // Persist user message
    await this.sessionStore
      .appendMessage(this.agentConfig.id, sessionId, {
        role: 'user',
        content: message,
        ts: Date.now(),
      })
      .catch(() => {});

    this.pendingApiSessions.add(sessionId);
    session.touch();

    const buffer: string[] = [];
    let settled = false;
    // Track partial message text for delta computation (--include-partial-messages)
    let lastPartialText = '';

    const done = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Persist assistant reply
      if (result.trim()) {
        this.sessionStore
          .appendMessage(this.agentConfig.id, sessionId, {
            role: 'assistant',
            content: result.trim(),
            ts: Date.now(),
          })
          .catch(() => {});
      }
      callbacks.onDone(result.trim());
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      callbacks.onError(err);
    };

    const cleanup = () => {
      clearTimeout(globalTimer);
      session.off('output', onOutput);
      this.pendingApiSessions.delete(sessionId);
    };

    const onOutput = (line: string) => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;

        // Partial assistant message (from --include-partial-messages)
        // Contains cumulative text; compute delta and emit as text_delta
        if (obj['type'] === 'assistant') {
          const msg = obj['message'] as { content?: Array<{ type: string; text?: string }> } | undefined;
          if (Array.isArray(msg?.content)) {
            let fullText = '';
            for (const block of msg!.content) {
              if (block.type === 'text' && block.text) fullText += block.text;
            }
            if (fullText.length > lastPartialText.length) {
              const delta = fullText.slice(lastPartialText.length);
              buffer.push(delta);
              callbacks.onChunk({ type: 'text_delta', text: delta });
            }
            lastPartialText = fullText;
          }
        }

        // Standalone text delta (legacy format)
        if (obj['type'] === 'text') {
          const text = (obj['text'] as string) ?? '';
          if (text) {
            buffer.push(text);
            callbacks.onChunk({ type: 'text_delta', text });
          }
        }

        // stream_event from --output-format stream-json
        // Format: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
        if (obj['type'] === 'stream_event') {
          const event = obj['event'] as Record<string, unknown> | undefined;
          if (event?.['type'] === 'content_block_delta') {
            const delta = event['delta'] as Record<string, unknown> | undefined;
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
              buffer.push(delta['text']);
              // Update lastPartialText so the final 'assistant' message won't re-send the full text
              lastPartialText += delta['text'];
              callbacks.onChunk({ type: 'text_delta', text: delta['text'] });
            }
          }
        }

        // Text from delta field (other formats)
        if (obj['type'] !== 'assistant' && obj['type'] !== 'text' && obj['type'] !== 'result' && obj['type'] !== 'stream_event') {
          const deltaText = (obj['delta'] as Record<string, unknown> | undefined)?.['text'] as string | undefined;
          if (deltaText) {
            buffer.push(deltaText);
            callbacks.onChunk({ type: 'text_delta', text: deltaText });
          }
        }

        // Tool use
        if (obj['type'] === 'tool_use') {
          callbacks.onChunk({
            type: 'tool_use',
            name: (obj['name'] as string) ?? '',
            id: (obj['id'] as string) ?? '',
          });
        }

        // Thinking
        if (obj['type'] === 'thinking') {
          callbacks.onChunk({
            type: 'thinking',
            text: (obj['text'] as string) ?? '',
          });
        }

        // Result = end of turn
        if (obj['type'] === 'result') {
          session.setProcessing(false);
          lastPartialText = ''; // reset for next turn
          const resultText = (obj['result'] as string | undefined) ?? buffer.join('');
          done(resultText);
        }
      } catch {
        /* non-JSON stdout line */
      }
    };

    const globalTimer = setTimeout(() => {
      session.setProcessing(false);
      fail(Object.assign(new Error('Agent response timeout'), { code: 'TIMEOUT' }));
    }, opts.timeoutMs);

    session.on('output', onOutput);

    const systemNote = buildApiSystemNote(opts.allowTools ?? false);

    const channelXml =
      `<channel source="api" session_id="${sessionId}" ts="${new Date().toISOString()}">\n` +
      `${message}\n\n` +
      systemNote +
      `</channel>`;

    session.setProcessing(true);
    session.sendMessage(channelXml);

    // Return cleanup function for client disconnect
    return () => {
      if (!settled) {
        settled = true;
        cleanup();
      }
    };
  }

  /**
   * Check if a session has a pending API request (for preflight conflict check).
   */
  hasActiveApiSession(sessionId: string): boolean {
    return this.pendingApiSessions.has(sessionId);
  }

  /**
   * Expose the callback server port for integration tests that need to simulate
   * incoming Telegram messages by POSTing directly to the channel endpoint.
   */
  getCallbackPort(): number {
    return this.callbackPort;
  }

  /**
   * Send a message to all active sessions.
   * Used for heartbeat/cron tasks delivered out-of-band.
   *
   * If no Telegram sessions are active, a transient `__heartbeat__` API session is
   * spawned so that CronScheduler tasks can always run regardless of active user sessions.
   */
  sendMessage(message: string): void {
    if (this.sessions.size === 0) {
      // No active user sessions — spawn a shared heartbeat session so the prompt
      // reaches a subprocess and output events fire for CronScheduler/tests.
      this.getOrSpawnSession('__heartbeat__', 'api')
        .then((session) => {
          session.sendMessage(message);
          session.touch();
        })
        .catch((err) =>
          this.logger.error('sendMessage failed to spawn heartbeat session', {
            error: (err as Error).message,
          }),
        );
      return;
    }
    for (const session of this.sessions.values()) {
      session.sendMessage(message);
    }
  }
}
