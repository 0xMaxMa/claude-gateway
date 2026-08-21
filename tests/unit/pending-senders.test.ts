/**
 * Unit tests for the shared pending-senders store (src/api/pending-senders.ts).
 * In-memory, deterministic via injected `now`. Originally LINE-only; now
 * namespaced by `channel` so LINE and Slack (and future webhook channels)
 * share the module without their knock lists mixing.
 */
import {
  recordDeniedSender,
  recordDeniedConversation,
  getPendingSenders,
  getPendingSender,
  clearPendingSender,
  generatePairingCode,
  _resetPendingSenders,
  MAX_PENDING_PER_AGENT,
} from '../../src/api/pending-senders';

const A = 'getpod';
const L = 'line';
const S = 'slack';

describe('pending store', () => {
  beforeEach(() => _resetPendingSenders());

  it('records a denied sender with display name', () => {
    recordDeniedSender(L, A, 'Ualice', 'Alice', 1000);
    const list = getPendingSenders(L, A);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: 'Ualice', displayName: 'Alice', count: 1, firstSeen: 1000, lastSeen: 1000 });
  });

  it('dedups by userId: bumps count + lastSeen, backfills displayName', () => {
    recordDeniedSender(L, A, 'Ualice', undefined, 1000);
    recordDeniedSender(L, A, 'Ualice', 'Alice', 2000);
    const list = getPendingSenders(L, A);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ count: 2, firstSeen: 1000, lastSeen: 2000, displayName: 'Alice' });
  });

  it('returns most-recent first', () => {
    recordDeniedSender(L, A, 'Ua', 'A', 1000);
    recordDeniedSender(L, A, 'Ub', 'B', 3000);
    recordDeniedSender(L, A, 'Uc', 'C', 2000);
    expect(getPendingSenders(L, A).map((s) => s.userId)).toEqual(['Ub', 'Uc', 'Ua']);
  });

  it('caps per (channel, agent), evicting the least-recently-seen', () => {
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i++) {
      recordDeniedSender(L, A, `U${i}`, undefined, 1000 + i);
    }
    // U0 is oldest; adding one more evicts it
    recordDeniedSender(L, A, 'Unew', undefined, 9999);
    const ids = getPendingSenders(L, A).map((s) => s.userId);
    expect(ids).toHaveLength(MAX_PENDING_PER_AGENT);
    expect(ids).toContain('Unew');
    expect(ids).not.toContain('U0');
  });

  it('isolates agents', () => {
    recordDeniedSender(L, 'a1', 'Ux', undefined, 1);
    recordDeniedSender(L, 'a2', 'Uy', undefined, 1);
    expect(getPendingSenders(L, 'a1').map((s) => s.userId)).toEqual(['Ux']);
    expect(getPendingSenders(L, 'a2').map((s) => s.userId)).toEqual(['Uy']);
  });

  it('isolates channels on the same agent, even with the same id', () => {
    // Same id in both channels' id spaces — must not merge, dedup, or share the eviction cap.
    recordDeniedSender(L, A, 'SAME', 'Line sender', 1);
    recordDeniedSender(S, A, 'SAME', 'Slack sender', 2);
    expect(getPendingSenders(L, A)).toEqual([
      expect.objectContaining({ userId: 'SAME', displayName: 'Line sender', count: 1 }),
    ]);
    expect(getPendingSenders(S, A)).toEqual([
      expect.objectContaining({ userId: 'SAME', displayName: 'Slack sender', count: 1 }),
    ]);
    // Clearing one channel's entry must not touch the other's.
    clearPendingSender(L, A, 'SAME');
    expect(getPendingSenders(L, A)).toHaveLength(0);
    expect(getPendingSenders(S, A)).toHaveLength(1);
  });

  it('clearPendingSender drops one user (e.g. after adding to allowlist)', () => {
    recordDeniedSender(L, A, 'Ualice', undefined, 1);
    recordDeniedSender(L, A, 'Ubob', undefined, 2);
    clearPendingSender(L, A, 'Ualice');
    expect(getPendingSenders(L, A).map((s) => s.userId)).toEqual(['Ubob']);
  });

  it('ignores empty channel, agentId, or userId', () => {
    recordDeniedSender('', A, 'Ux');
    recordDeniedSender(L, '', 'Ux');
    recordDeniedSender(L, A, '');
    expect(getPendingSenders(L, A)).toHaveLength(0);
  });

  describe('recordDeniedConversation (group/room)', () => {
    it('records a group with kind + name', () => {
      recordDeniedConversation(L, A, 'Cgroup1', 'group', 'Team Dev', 1000);
      const list = getPendingSenders(L, A);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ userId: 'Cgroup1', displayName: 'Team Dev', kind: 'group', count: 1 });
    });

    it('records a room (no name) with kind room', () => {
      recordDeniedConversation(L, A, 'Rroom1', 'room', undefined, 1000);
      expect(getPendingSenders(L, A)[0]).toMatchObject({ userId: 'Rroom1', kind: 'room' });
      expect(getPendingSenders(L, A)[0].displayName).toBeUndefined();
    });

    it('dedups a group by id, backfilling the name on a later resolve', () => {
      recordDeniedConversation(L, A, 'Cg', 'group', undefined, 1000);
      recordDeniedConversation(L, A, 'Cg', 'group', 'Family', 2000);
      const list = getPendingSenders(L, A);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ count: 2, displayName: 'Family', kind: 'group' });
    });

    it('users and groups coexist in one knock list, tagged by kind', () => {
      recordDeniedSender(L, A, 'Ualice', 'Alice', 1000);
      recordDeniedConversation(L, A, 'Cteam', 'group', 'Team', 2000);
      const byId = Object.fromEntries(getPendingSenders(L, A).map((s) => [s.userId, s.kind]));
      expect(byId).toEqual({ Ualice: 'user', Cteam: 'group' });
    });

    it('clearPendingSender drops a group id too (after adding to groupAllowlist)', () => {
      recordDeniedConversation(L, A, 'Cteam', 'group', 'Team', 1);
      clearPendingSender(L, A, 'Cteam');
      expect(getPendingSenders(L, A)).toHaveLength(0);
    });
  });

  describe('pairing code', () => {
    it('generatePairingCode is 6 uppercase hex', () => {
      for (let i = 0; i < 50; i++) {
        expect(generatePairingCode()).toMatch(/^[0-9A-F]{6}$/);
      }
    });

    it('returns true (wasNew) on first contact, false on dedup', () => {
      expect(recordDeniedSender(L, A, 'Ualice', undefined, 1000, 'ABC123')).toBe(true);
      expect(recordDeniedSender(L, A, 'Ualice', undefined, 2000, 'ZZZ999')).toBe(false);
    });

    it('sets code on create and never overwrites it on dedup', () => {
      recordDeniedSender(L, A, 'Ualice', undefined, 1000, 'ABC123');
      recordDeniedSender(L, A, 'Ualice', 'Alice', 2000, 'ZZZ999');
      expect(getPendingSender(L, A, 'Ualice')?.code).toBe('ABC123');
    });

    it('stores a code for group/room entries too', () => {
      expect(recordDeniedConversation(L, A, 'Cteam', 'group', undefined, 1000, 'DEAD01')).toBe(true);
      expect(getPendingSender(L, A, 'Cteam')?.code).toBe('DEAD01');
    });

    it('getPendingSender returns undefined for an unknown id', () => {
      expect(getPendingSender(L, A, 'Unope')).toBeUndefined();
    });

    it('leaves code undefined when none is passed (pairing off)', () => {
      recordDeniedSender(L, A, 'Ubob', 'Bob', 1000);
      expect(getPendingSender(L, A, 'Ubob')?.code).toBeUndefined();
    });
  });
});
