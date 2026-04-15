/**
 * Mock Telegram Bot API server for E2E testing.
 * Simulates getUpdates, sendMessage, setMessageReaction, editMessageText, getFile.
 */

import * as http from 'http';

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; username?: string; is_bot: boolean };
    chat: { id: number; type: string };
    date: number;
    text?: string;
    photo?: Array<{ file_id: string; file_unique_id: string }>;
    caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>;
  };
};

export type SentMessage = {
  method: string;
  chat_id: string;
  text?: string;
  reply_parameters?: { message_id: number };
  parse_mode?: string;
  emoji?: string;
  message_id?: string;
};

export class MockTelegramServer {
  private server: http.Server;
  private updates: TelegramUpdate[] = [];
  private sentMessages: SentMessage[] = [];
  private nextUpdateId = 1;
  private nextMessageId = 100;
  port = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const url = req.url ?? '';
        const params = body ? JSON.parse(body) : {};

        if (url.includes('/file/bot')) {
          // Serve a fake file for download_attachment tests
          this.sentMessages.push({ method: 'downloadFile', chat_id: '', text: url });
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(Buffer.from('fake-image-data'));
          return;
        } else if (url.includes('/getUpdates')) {
          const result = this.updates.splice(0);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } else if (url.includes('/sendMessage')) {
          const msgId = this.nextMessageId++;
          this.sentMessages.push({ method: 'sendMessage', ...params });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { message_id: msgId } }));
        } else if (url.includes('/setMessageReaction')) {
          this.sentMessages.push({ method: 'setMessageReaction', ...params });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: true }));
        } else if (url.includes('/editMessageText')) {
          this.sentMessages.push({ method: 'editMessageText', ...params });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { message_id: params.message_id ?? 1 } }));
        } else if (url.includes('/getFile')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { file_id: params.file_id, file_unique_id: 'uniq123', file_path: 'photos/test.jpg' } }));
        } else if (url.includes('/getMe')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'test_bot' } }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: true }));
        }
      });
    });
  }

  async start(): Promise<void> {
    return new Promise(resolve => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise(resolve => {
      this.server.close(() => resolve());
    });
  }

  enqueueUpdate(update: Partial<NonNullable<TelegramUpdate['message']>>): void {
    const updateId = this.nextUpdateId++;
    this.updates.push({
      update_id: updateId,
      message: {
        message_id: update.message_id ?? this.nextMessageId++,
        from: update.from ?? { id: 12345, username: 'test_user', is_bot: false },
        chat: update.chat ?? { id: 67890, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: update.text,
        photo: update.photo,
        caption: update.caption,
        entities: update.entities,
      },
    });
  }

  getSentMessages(): SentMessage[] {
    return [...this.sentMessages];
  }

  assertReplied(chatId: string, textContains: string): void {
    const found = this.sentMessages.find(
      m => m.method === 'sendMessage' && m.chat_id === chatId && m.text?.includes(textContains),
    );
    if (!found) {
      throw new Error(
        `Expected reply to chat ${chatId} containing "${textContains}" but found: ${JSON.stringify(this.sentMessages)}`,
      );
    }
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }

  getApiRoot(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}
