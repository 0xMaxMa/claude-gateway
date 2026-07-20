import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock the outbound sender so no real Discord call happens; count invocations.
// (jest allows referencing an out-of-scope var in the factory when it is prefixed `mock`.)
const mockSendMessage = jest.fn(async () => [{ id: 'mid' }]);
jest.mock('../../mcp/tools/discord/outbound', () => ({
  sendMessage: mockSendMessage,
  buildChoiceComponents: () => [],
}));

import { DiscordModule } from '../../mcp/tools/discord/module';

let tmp: string;
let fileA: string;
let fileB: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddtest-'));
  fileA = path.join(tmp, 'a.png');
  fileB = path.join(tmp, 'b.png');
  fs.writeFileSync(fileA, 'x'); // real, tiny files so the size check passes
  fs.writeFileSync(fileB, 'x');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freshModule(): any {
  const mod: any = new DiscordModule();
  mod.client = { channels: { fetch: async () => ({}) } };
  return mod;
}

describe('discord_reply file dedup (retry spam guard)', () => {
  beforeEach(() => mockSendMessage.mockClear());

  it('never re-sends the same file twice in a session', async () => {
    const mod = freshModule();
    const args = { channel_id: 'c1', files: [fileA] };

    const r1 = await mod.handleReply(args);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(r1.content[0].text).toMatch(/^sent/);

    // Agent retries the SAME image (thinks the first send failed) → suppressed.
    const r2 = await mod.handleReply(args);
    expect(mockSendMessage).toHaveBeenCalledTimes(1); // NOT sent again
    expect(r2.content[0].text).toMatch(/already sent/);
  });

  it('still sends a genuinely NEW file, and still sends text-only replies', async () => {
    const mod = freshModule();

    await mod.handleReply({ channel_id: 'c', files: [fileA] });
    await mod.handleReply({ channel_id: 'c', files: [fileB] }); // different file → sends
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    await mod.handleReply({ channel_id: 'c', text: 'here you go' }); // text only → sends
    expect(mockSendMessage).toHaveBeenCalledTimes(3);
  });

  it('dedup is per-instance (a new session starts clean)', async () => {
    const modA = freshModule();
    await modA.handleReply({ channel_id: 'c', files: [fileA] });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    const modB = freshModule(); // new session
    await modB.handleReply({ channel_id: 'c', files: [fileA] }); // same path, new session → sends
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });
});
