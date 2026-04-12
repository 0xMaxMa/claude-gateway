import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { AgentConfig, GatewayConfig, Logger, StreamEvent } from './types';
import { createLogger } from './logger';
import { SessionProcess } from './session-process';
import { SessionStore } from './session-store';
import { TelegramReceiver } from './telegram-receiver';
import { hasMarkdown, toMarkdownV2 } from './markdown';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_MAX_CONCURRENT = 20;

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', alias: 'opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', alias: 'sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', alias: 'haiku' },
] as const;

export class AgentRunner extends EventEmitter {
  private readonly agentConfig: AgentConfig;
  private readonly gatewayConfig: GatewayConfig;
  private readonly logger: Logger;
  private stopping = false;
  private callbackServer: http.Server | null = null;
  private callbackPort = 0;

  // Session pool
  private readonly sessions = new Map<string, SessionProcess>();
  private receiver: TelegramReceiver | null = null;
  private readonly sessionStore: SessionStore;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrent: number;
  private idleCleanerTimer: ReturnType<typeof setInterval> | null = null;

  // Tracks session IDs with an in-flight API request (prevents concurrent turns)
  private readonly pendingApiSessions = new Set<string>();

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

          // Append user message to session store
          this.sessionStore
            .appendMessage(this.agentConfig.id, chatId, {
              role: 'user',
              content,
              ts: Date.now(),
            })
            .catch(() => {});

          // Route to session, inject as channel XML
          this.getOrSpawnSession(chatId, 'telegram')
            .then((session) => {
              const channelXml = AgentRunner.buildChannelXml(params);
              session.sendMessage(channelXml);
              session.touch();
              this.logger.debug('Injected channel turn into session', {
                chatId,
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
  private handleCommandRequest(raw: string, res: http.ServerResponse): void {
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
      const valid = AVAILABLE_MODELS.find(m => m.id === newModel);
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

    return (
      `<channel source="telegram" chat_id="${meta['chat_id'] ?? ''}" ` +
      `message_id="${meta['message_id'] ?? ''}" user="${meta['user'] ?? ''}" ` +
      `ts="${meta['ts'] ?? new Date().toISOString()}"${optionalAttrs}>${repliedBlock}${params.content ?? ''}</channel>`
    );
  }

  private async getOrSpawnSession(
    sessionId: string,
    source: 'telegram' | 'api',
  ): Promise<SessionProcess> {
    const existing = this.sessions.get(sessionId);
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

    const proc = new SessionProcess(
      sessionId,
      source,
      this.agentConfig,
      this.gatewayConfig,
      this.sessionStore,
    );
    await proc.start();

    // Forward all session output lines so listeners on AgentRunner (GatewayRouter,
    // CronScheduler, tests) receive them without needing individual session references.
    proc.on('output', (line: string) => this.emit('output', line));

    // Notify typing indicator when session permanently fails (max restarts exceeded)
    if (source === 'telegram') {
      proc.once('failed', () => {
        this.writeTypingError(sessionId, 'PROCESS_FAILED');
        this.sessions.delete(sessionId);
      });
      // Stop typing loop when Claude's turn truly ends.
      // Typing done is delayed 3s after result event — if new output arrives within
      // the delay, the timer is cancelled so typing persists during multi-step work.
      // Auto-forward result text to Telegram if agent didn't call reply tool.
      let replyCalled = false;
      let typingDoneTimer: ReturnType<typeof setTimeout> | null = null;
      const TYPING_DONE_DELAY_MS = 3000;

      proc.on('output', (line: string) => {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;

          // Cancel pending typing-done on any new output
          if (typingDoneTimer) {
            clearTimeout(typingDoneTimer);
            typingDoneTimer = null;
          }

          // Track mcp__telegram__reply tool calls
          if (obj['type'] === 'assistant') {
            const msg = obj['message'] as { content?: Array<{ type: string; name?: string }> } | undefined;
            if (Array.isArray(msg?.content)) {
              for (const block of msg!.content) {
                if (block.type === 'tool_use' && block.name === 'mcp__telegram__reply') {
                  replyCalled = true;
                }
              }
            }
          }
          if (obj['type'] === 'result') {
            // Always forward result text — it contains the agent's completion summary.
            // If the agent also called reply tool, this summary still reaches the user.
            const resultText = typeof obj['result'] === 'string' ? obj['result'] : '';
            if (resultText.trim()) {
              const text = resultText.trim();
              if (hasMarkdown(text)) {
                this.writeAutoForward(sessionId, toMarkdownV2(text), 'markdownv2');
              } else {
                this.writeAutoForward(sessionId, text);
              }
            }
            replyCalled = false; // reset for next turn
            // Delay typing done — agent may continue with more work
            typingDoneTimer = setTimeout(() => {
              this.writeTypingDone(sessionId);
              typingDoneTimer = null;
            }, TYPING_DONE_DELAY_MS);
          }
        } catch { /* non-JSON */ }
      });

      // Clean up pending typing-done timer when session stops
      proc.once('exit', () => {
        if (typingDoneTimer) {
          clearTimeout(typingDoneTimer);
          typingDoneTimer = null;
        }
        this.writeTypingDone(sessionId);
      });
    }

    this.sessions.set(sessionId, proc);
    this.logger.info('Spawned session', {
      sessionId,
      source,
      total: this.sessions.size,
    });
    return proc;
  }

  /**
   * Write an error code to the typing signal directory so the receiver's
   * typing loop can pick it up and notify the user via Telegram.
   * Non-fatal: if the write fails the typing loop will stop via stalled timer.
   */
  private writeTypingError(chatId: string, code: string): void {
    const typingDir = path.join(this.agentConfig.workspace, '.telegram-state', 'typing');
    try {
      fs.mkdirSync(typingDir, { recursive: true });
      fs.writeFileSync(path.join(typingDir, `${chatId}.error`), code);
    } catch {
      // Non-fatal — typing loop will stop via stalled timer instead
    }
  }

  /**
   * Delete the typing signal file so the receiver's typing loop stops on next tick.
   * Called when Claude's turn is truly complete (result event), not on individual reply calls.
   */
  private writeTypingDone(chatId: string): void {
    const typingDir = path.join(this.agentConfig.workspace, '.telegram-state', 'typing');
    try {
      fs.rmSync(path.join(typingDir, chatId), { force: true });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Write result text to a forward file so the typing plugin sends it to Telegram.
   * Used when the agent produces text output but didn't call mcp__telegram__reply.
   * The file is written as JSON { text, format } so the receiver can apply the
   * correct parse_mode when sending the Telegram message.
   */
  private writeAutoForward(chatId: string, text: string, format: 'text' | 'markdownv2' = 'text'): void {
    const typingDir = path.join(this.agentConfig.workspace, '.telegram-state', 'typing');
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

  async start(bootstrapPrompt?: string): Promise<void> {
    void bootstrapPrompt; // reserved for future use
    this.stopping = false;
    await this.startCallbackServer();
    this.receiver = new TelegramReceiver(
      this.agentConfig,
      this.callbackPort,
      this.gatewayConfig.gateway.logDir,
    );
    this.receiver.start();
    this.startIdleCleaner();
    this.logger.info('AgentRunner started', { agentId: this.agentConfig.id });
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
    opts: { timeoutMs: number },
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

    const channelXml =
      `<channel source="api" session_id="${sessionId}" ts="${new Date().toISOString()}">\n` +
      `${message}\n\n` +
      `[SYSTEM: This is an API request. Reply with plain text only. ` +
      `Do NOT call any tools. Your text output will be returned directly to the caller.]\n` +
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
            const resultText = (obj['result'] as string | undefined) ?? buffer.join('');
            done(resultText);
          }
        } catch {
          /* non-JSON stdout line */
        }
      };

      const globalTimer = setTimeout(() => {
        fail(Object.assign(new Error('Agent response timeout'), { code: 'TIMEOUT' }));
      }, opts.timeoutMs);

      session.on('output', onOutput);
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
    opts: { timeoutMs: number },
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
          lastPartialText = ''; // reset for next turn
          const resultText = (obj['result'] as string | undefined) ?? buffer.join('');
          done(resultText);
        }
      } catch {
        /* non-JSON stdout line */
      }
    };

    const globalTimer = setTimeout(() => {
      fail(Object.assign(new Error('Agent response timeout'), { code: 'TIMEOUT' }));
    }, opts.timeoutMs);

    session.on('output', onOutput);

    const channelXml =
      `<channel source="api" session_id="${sessionId}" ts="${new Date().toISOString()}">\n` +
      `${message}\n\n` +
      `[SYSTEM: This is an API request. Reply with plain text only. ` +
      `Do NOT call any tools. Your text output will be returned directly to the caller.]\n` +
      `</channel>`;

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
