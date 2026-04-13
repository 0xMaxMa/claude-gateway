import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import PQueue from 'p-queue';
import { Message, SessionIndex, SessionMeta } from './types';

export class SessionStore {
  private readonly agentsBaseDir: string;
  private readonly queues = new Map<string, PQueue>();

  constructor(agentsBaseDir: string) {
    this.agentsBaseDir = agentsBaseDir;
  }

  /**
   * Return the base directory where all agents' data is stored.
   */
  getAgentsBaseDir(): string {
    return this.agentsBaseDir;
  }

  /**
   * Return the session key for a given agent + chat combination.
   */
  resolveKey(agentId: string, chatId: string): string {
    return `agent:${agentId}:telegram:${chatId}`;
  }

  /**
   * Resolve the file path for a legacy API session (JSONL format).
   */
  private resolvePath(agentId: string, chatId: string): string {
    return path.join(this.agentsBaseDir, agentId, 'sessions', `${chatId}.jsonl`);
  }

  /**
   * Get or create a per-file serialization queue (prevents concurrent write corruption).
   * For telegram multi-session operations the key is prefixed with 'telegram-'.
   */
  private getQueue(agentId: string, chatId: string): PQueue {
    const key = this.resolveKey(agentId, chatId);
    if (!this.queues.has(key)) {
      this.queues.set(key, new PQueue({ concurrency: 1 }));
    }
    return this.queues.get(key)!;
  }

  /**
   * Get or create a serialization queue keyed on telegram-{chatId} for index operations.
   */
  private getTelegramQueue(agentId: string, chatId: string): PQueue {
    const key = `agent:${agentId}:telegram-index:${chatId}`;
    if (!this.queues.has(key)) {
      this.queues.set(key, new PQueue({ concurrency: 1 }));
    }
    return this.queues.get(key)!;
  }

  /**
   * Load all messages from a session file.
   * Returns empty array if file doesn't exist.
   * Resets to empty (and logs) if file is corrupt.
   */
  async loadSession(agentId: string, chatId: string): Promise<Message[]> {
    const filePath = this.resolvePath(agentId, chatId);

    if (!fs.existsSync(filePath)) {
      return [];
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const messages: Message[] = [];

    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Message;
        messages.push(msg);
      } catch {
        // Corrupted line — reset the session
        console.error(`[SessionStore] Corrupted session file at ${filePath}, resetting.`);
        await this.resetSession(agentId, chatId);
        return [];
      }
    }

    return messages;
  }

  /**
   * Append a single message to a session file.
   * Creates the file (and parent directories) if needed.
   * Serialized per-session via p-queue to prevent concurrent corruption.
   */
  async appendMessage(agentId: string, chatId: string, message: Message): Promise<void> {
    const queue = this.getQueue(agentId, chatId);
    await queue.add(async () => {
      const filePath = this.resolvePath(agentId, chatId);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify(message) + '\n';
      fs.appendFileSync(filePath, line, 'utf-8');
    });
  }

  /**
   * Reset a session by deleting (or truncating) the session file.
   */
  async resetSession(agentId: string, chatId: string): Promise<void> {
    const queue = this.getQueue(agentId, chatId);
    await queue.add(async () => {
      const filePath = this.resolvePath(agentId, chatId);
      try {
        fs.writeFileSync(filePath, '', 'utf-8');
      } catch {
        // File might not exist yet; that's fine
      }
    });
  }

  /**
   * Delete session files older than maxAgeDays.
   * Returns the count of deleted files.
   */
  async pruneOldSessions(agentId: string, maxAgeDays: number): Promise<number> {
    const sessionsDir = path.join(this.agentsBaseDir, agentId, 'sessions');

    if (!fs.existsSync(sessionsDir)) {
      return 0;
    }

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    const entries = fs.readdirSync(sessionsDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(sessionsDir, entry);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // Ignore errors for individual files
      }
    }

    return deleted;
  }

  // ─── Multi-session Telegram support ──────────────────────────────────────────

  /**
   * Resolve the directory for a telegram chat's multi-session data.
   */
  private resolveTelegramDir(agentId: string, chatId: string): string {
    return path.join(this.agentsBaseDir, agentId, 'sessions', `telegram-${chatId}`);
  }

  /**
   * Resolve the path to the session index file for a telegram chat.
   */
  private resolveTelegramIndexPath(agentId: string, chatId: string): string {
    return path.join(this.resolveTelegramDir(agentId, chatId), 'index.json');
  }

  /**
   * Resolve the path to a specific session's message file.
   */
  private resolveTelegramSessionPath(agentId: string, chatId: string, sessionId: string): string {
    return path.join(this.resolveTelegramDir(agentId, chatId), `${sessionId}.json`);
  }

  /**
   * Read index.json for a telegram chat. Returns null if file doesn't exist.
   */
  async loadIndex(agentId: string, chatId: string): Promise<SessionIndex | null> {
    const indexPath = this.resolveTelegramIndexPath(agentId, chatId);
    if (!fs.existsSync(indexPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(indexPath, 'utf-8');
      return JSON.parse(raw) as SessionIndex;
    } catch {
      return null;
    }
  }

  /**
   * Write index.json atomically (tmp + rename).
   */
  async saveIndex(agentId: string, chatId: string, index: SessionIndex): Promise<void> {
    const indexPath = this.resolveTelegramIndexPath(agentId, chatId);
    const dir = path.dirname(indexPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, indexPath);
  }

  /**
   * Get or create the session index for a telegram chat.
   *
   * Migration logic:
   * 1. If telegram-{chatId}/index.json exists → return it
   * 2. If old {chatId}.jsonl exists → migrate to new layout, delete old file
   * 3. Otherwise → create a fresh index with one empty "Session 1"
   *
   * All operations are serialized via the telegram index queue.
   */
  /**
   * Internal (unlocked) version — call this only from WITHIN a getTelegramQueue task
   * to avoid deadlock. The public getOrCreateIndex wraps this in the queue.
   */
  private async loadOrCreateIndexUnlocked(agentId: string, chatId: string): Promise<SessionIndex> {
    // 1. Check for existing index
    const existingIndex = await this.loadIndex(agentId, chatId);
    if (existingIndex !== null) {
      return existingIndex;
    }

    // 2. Check for old JSONL file → migrate
    const oldPath = this.resolvePath(agentId, chatId);
    if (fs.existsSync(oldPath)) {
      const raw = fs.readFileSync(oldPath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim() !== '');
      const messages: Message[] = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line) as Message);
        } catch {
          // Skip corrupted lines during migration
        }
      }

      const newId = randomUUID();
      const now = Date.now();
      const meta: SessionMeta = {
        id: newId,
        name: 'Session 1',

        createdAt: now,
        lastActive: now,
        messageCount: messages.length,
        totalTokensUsed: 0,
      };
      const index: SessionIndex = {
        activeSessionId: newId,
        sessions: [meta],
      };

      const telegramDir = this.resolveTelegramDir(agentId, chatId);
      fs.mkdirSync(telegramDir, { recursive: true });
      const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, newId);
      fs.writeFileSync(sessionPath, JSON.stringify(messages, null, 2) + '\n', 'utf-8');
      await this.saveIndex(agentId, chatId, index);
      try { fs.unlinkSync(oldPath); } catch { /* non-fatal */ }
      return index;
    }

    // 3. Create fresh index with one empty session
    const newId = randomUUID();
    const now = Date.now();
    const meta: SessionMeta = {
      id: newId,
      name: 'Session 1',
      createdAt: now,
      lastActive: now,
      messageCount: 0,
      totalTokensUsed: 0,
    };
    const index: SessionIndex = {
      activeSessionId: newId,
      sessions: [meta],
    };
    const telegramDir = this.resolveTelegramDir(agentId, chatId);
    fs.mkdirSync(telegramDir, { recursive: true });
    const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, newId);
    fs.writeFileSync(sessionPath, JSON.stringify([], null, 2) + '\n', 'utf-8');
    await this.saveIndex(agentId, chatId, index);
    return index;
  }

  async getOrCreateIndex(agentId: string, chatId: string): Promise<SessionIndex> {
    const queue = this.getTelegramQueue(agentId, chatId);
    return queue.add(() => this.loadOrCreateIndexUnlocked(agentId, chatId)) as Promise<SessionIndex>;
  }

  /**
   * Create a new session for a telegram chat, add it to the index, and return the SessionMeta.
   * If name is not provided, auto-generates "Session N" based on current session count.
   */
  async createTelegramSession(agentId: string, chatId: string, name?: string): Promise<SessionMeta> {
    const queue = this.getTelegramQueue(agentId, chatId);
    return queue.add(async () => {
      const index = await this.loadOrCreateIndexUnlocked(agentId, chatId);
      const newId = randomUUID();
      const now = Date.now();
      const sessionName = name ?? `Session ${index.sessions.length + 1}`;
      const meta: SessionMeta = {
        id: newId,
        name: sessionName,

        createdAt: now,
        lastActive: now,
        messageCount: 0,
        totalTokensUsed: 0,
      };

      // Write empty messages file
      const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, newId);
      const telegramDir = this.resolveTelegramDir(agentId, chatId);
      fs.mkdirSync(telegramDir, { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify([], null, 2) + '\n', 'utf-8');

      // Update index
      index.sessions.push(meta);
      await this.saveIndex(agentId, chatId, index);

      return meta;
    }) as Promise<SessionMeta>;
  }

  /**
   * List all sessions for a telegram chat.
   */
  async listSessions(agentId: string, chatId: string): Promise<SessionIndex> {
    return this.getOrCreateIndex(agentId, chatId);
  }

  /**
   * Get the active session ID for a telegram chat.
   */
  async getActiveSessionId(agentId: string, chatId: string): Promise<string> {
    const index = await this.getOrCreateIndex(agentId, chatId);
    return index.activeSessionId;
  }

  /**
   * Set the active session for a telegram chat, updating index.json.
   */
  async setActiveSession(agentId: string, chatId: string, sessionId: string): Promise<void> {
    const queue = this.getTelegramQueue(agentId, chatId);
    await queue.add(async () => {
      const index = await this.loadIndex(agentId, chatId);
      if (!index) {
        throw new Error(`No session index found for chat ${chatId}`);
      }
      const exists = index.sessions.some((s) => s.id === sessionId);
      if (!exists) {
        throw new Error(`Session ${sessionId} not found in index for chat ${chatId}`);
      }
      index.activeSessionId = sessionId;
      await this.saveIndex(agentId, chatId, index);
    });
  }

  /**
   * Delete a session for a telegram chat. Cannot delete the last remaining session.
   */
  async deleteTelegramSession(agentId: string, chatId: string, sessionId: string): Promise<void> {
    const queue = this.getTelegramQueue(agentId, chatId);
    await queue.add(async () => {
      const index = await this.loadIndex(agentId, chatId);
      if (!index) {
        throw new Error(`No session index found for chat ${chatId}`);
      }
      if (index.sessions.length <= 1) {
        throw new Error(`Cannot delete the last session for chat ${chatId}`);
      }

      const sessionIdx = index.sessions.findIndex((s) => s.id === sessionId);
      if (sessionIdx === -1) {
        throw new Error(`Session ${sessionId} not found in index for chat ${chatId}`);
      }

      // Remove from index
      index.sessions.splice(sessionIdx, 1);

      // If we deleted the active session, promote the first remaining session
      if (index.activeSessionId === sessionId) {
        index.activeSessionId = index.sessions[0]!.id;
      }

      await this.saveIndex(agentId, chatId, index);

      // Delete the session messages file
      const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, sessionId);
      try {
        fs.unlinkSync(sessionPath);
      } catch {
        // Non-fatal if file doesn't exist
      }
    });
  }

  /**
   * Clear the history of a telegram session (reset messages to empty array).
   * Session meta is preserved and messageCount is reset to 0.
   */
  async clearTelegramSessionHistory(agentId: string, chatId: string, sessionId: string): Promise<void> {
    const queue = this.getTelegramQueue(agentId, chatId);
    await queue.add(async () => {
      const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, sessionId);
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, JSON.stringify([], null, 2) + '\n', 'utf-8');

      // Update meta: reset messageCount
      const index = await this.loadIndex(agentId, chatId);
      if (index) {
        const meta = index.sessions.find((s) => s.id === sessionId);
        if (meta) {
          meta.messageCount = 0;
          meta.lastActive = Date.now();
          await this.saveIndex(agentId, chatId, index);
        }
      }
    });
  }

  /**
   * Update specific meta fields for a telegram session.
   */
  async updateSessionMeta(
    agentId: string,
    chatId: string,
    sessionId: string,
    meta: Partial<Pick<SessionMeta, 'name' | 'totalTokensUsed' | 'messageCount' | 'lastInputTokens' | 'loadedAtSpawn' | 'archivedCount' | 'messageCountAtSpawn'>>,
  ): Promise<void> {
    const queue = this.getTelegramQueue(agentId, chatId);
    await queue.add(async () => {
      const index = await this.loadIndex(agentId, chatId);
      if (!index) {
        throw new Error(`No session index found for chat ${chatId}`);
      }
      const session = index.sessions.find((s) => s.id === sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found in index for chat ${chatId}`);
      }
      Object.assign(session, meta);
      session.lastActive = Date.now();
      await this.saveIndex(agentId, chatId, index);
    });
  }

  /**
   * Load messages for a telegram session. Returns Message[] (JSON array format).
   */
  async loadTelegramSession(agentId: string, chatId: string, sessionId: string): Promise<Message[]> {
    const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, sessionId);
    if (!fs.existsSync(sessionPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(sessionPath, 'utf-8');
      return JSON.parse(raw) as Message[];
    } catch {
      console.error(`[SessionStore] Corrupted telegram session file at ${sessionPath}, returning empty.`);
      return [];
    }
  }

  /**
   * Save all messages for a telegram session (overwrites the JSON array file).
   */
  async saveTelegramSession(
    agentId: string,
    chatId: string,
    sessionId: string,
    messages: Message[],
  ): Promise<void> {
    const queue = this.getTelegramQueue(agentId, chatId);
    await queue.add(async () => {
      const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, sessionId);
      const dir = path.dirname(sessionPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = sessionPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(messages, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, sessionPath);

      // Update meta messageCount and lastActive
      await this._updateMessageCountInIndex(agentId, chatId, sessionId, messages.length);
    });
  }

  /**
   * Append a single message to a telegram session.
   */
  async appendTelegramMessage(
    agentId: string,
    chatId: string,
    sessionId: string,
    message: Message,
  ): Promise<void> {
    const queue = this.getTelegramQueue(agentId, chatId);
    await queue.add(async () => {
      const sessionPath = this.resolveTelegramSessionPath(agentId, chatId, sessionId);
      const dir = path.dirname(sessionPath);
      fs.mkdirSync(dir, { recursive: true });

      // Load existing messages
      let messages: Message[] = [];
      if (fs.existsSync(sessionPath)) {
        try {
          const raw = fs.readFileSync(sessionPath, 'utf-8');
          messages = JSON.parse(raw) as Message[];
        } catch {
          messages = [];
        }
      }

      messages.push(message);

      // Write atomically
      const tmp = sessionPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(messages, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmp, sessionPath);

      // Update meta
      await this._updateMessageCountInIndex(agentId, chatId, sessionId, messages.length);
    });
  }

  private async _updateMessageCountInIndex(
    agentId: string,
    chatId: string,
    sessionId: string,
    count: number,
  ): Promise<void> {
    const index = await this.loadIndex(agentId, chatId);
    if (index) {
      const meta = index.sessions.find((s) => s.id === sessionId);
      if (meta) {
        meta.messageCount = count;
        meta.lastActive = Date.now();
        await this.saveIndex(agentId, chatId, index);
      }
    }
  }
}
