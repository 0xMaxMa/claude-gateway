import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HistoryDB } from '../../src/history/db';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-exclude-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.each([20000, 40000])('excluding %i sessions', (count) => {
  it('lists, pages, searches and counts days without a bind per session', () => {
    const db = HistoryDB.forAgent(dir, `agent-${count}`);
    const hidden = Array.from({ length: count }, (_, i) => `bound-${i}`);
    const now = Date.now();
    db.insertMessage({ chatId: 'api-web', sessionId: 'shown', source: 'api', role: 'user', content: 'visible words', ts: now });
    db.insertMessage({ chatId: 'api-web', sessionId: 'bound-7', source: 'api', role: 'user', content: 'visible secret', ts: now });
    db.insertMessage({ chatId: 'api-web', sessionId: hidden[count - 1]!, source: 'api', role: 'user', content: 'visible secret', ts: now });

    expect(db.listChats({ excludeSessionIds: hidden }).map((c) => [c.chatId, c.messageCount])).toEqual([['api-web', 1]]);
    expect(db.getMessages('api-web', { excludeSessionIds: hidden }).messages.map((m) => m.sessionId)).toEqual(['shown']);
    expect(db.searchMessages('api-web', 'visible', { excludeSessionIds: hidden }).results.map((r) => r.sessionId)).toEqual(['shown']);
    expect(db.getActiveDays('api-web', { from: now - 1e6, to: now + 1e6, tzOffset: 0, excludeSessionIds: hidden })).toHaveLength(1);
    expect(db.listChats({ excludeSessionIds: [] })[0]!.messageCount).toBe(3);
  });
});
