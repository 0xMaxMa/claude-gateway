/**
 * Unit tests for the LINE pending-senders store (src/api/line-pending-senders.ts).
 * In-memory, deterministic via injected `now`.
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
} from '../../src/api/line-pending-senders';

const A = 'getpod';

describe('line pending store', () => {
  beforeEach(() => _resetPendingSenders());

  it('records a denied sender with display name', () => {
    recordDeniedSender(A, 'Ualice', 'Alice', 1000);
    const list = getPendingSenders(A);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: 'Ualice', displayName: 'Alice', count: 1, firstSeen: 1000, lastSeen: 1000 });
  });

  it('dedups by userId: bumps count + lastSeen, backfills displayName', () => {
    recordDeniedSender(A, 'Ualice', undefined, 1000);
    recordDeniedSender(A, 'Ualice', 'Alice', 2000);
    const list = getPendingSenders(A);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ count: 2, firstSeen: 1000, lastSeen: 2000, displayName: 'Alice' });
  });

  it('returns most-recent first', () => {
    recordDeniedSender(A, 'Ua', 'A', 1000);
    recordDeniedSender(A, 'Ub', 'B', 3000);
    recordDeniedSender(A, 'Uc', 'C', 2000);
    expect(getPendingSenders(A).map((s) => s.userId)).toEqual(['Ub', 'Uc', 'Ua']);
  });

  it('caps per agent, evicting the least-recently-seen', () => {
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i++) {
      recordDeniedSender(A, `U${i}`, undefined, 1000 + i);
    }
    // U0 is oldest; adding one more evicts it
    recordDeniedSender(A, 'Unew', undefined, 9999);
    const ids = getPendingSenders(A).map((s) => s.userId);
    expect(ids).toHaveLength(MAX_PENDING_PER_AGENT);
    expect(ids).toContain('Unew');
    expect(ids).not.toContain('U0');
  });

  it('isolates agents', () => {
    recordDeniedSender('a1', 'Ux', undefined, 1);
    recordDeniedSender('a2', 'Uy', undefined, 1);
    expect(getPendingSenders('a1').map((s) => s.userId)).toEqual(['Ux']);
    expect(getPendingSenders('a2').map((s) => s.userId)).toEqual(['Uy']);
  });

  it('clearPendingSender drops one user (e.g. after adding to allowlist)', () => {
    recordDeniedSender(A, 'Ualice', undefined, 1);
    recordDeniedSender(A, 'Ubob', undefined, 2);
    clearPendingSender(A, 'Ualice');
    expect(getPendingSenders(A).map((s) => s.userId)).toEqual(['Ubob']);
  });

  it('ignores empty agentId or userId', () => {
    recordDeniedSender('', 'Ux');
    recordDeniedSender(A, '');
    expect(getPendingSenders(A)).toHaveLength(0);
  });

  describe('recordDeniedConversation (group/room)', () => {
    it('records a group with kind + name', () => {
      recordDeniedConversation(A, 'Cgroup1', 'group', 'Team Dev', 1000);
      const list = getPendingSenders(A);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ userId: 'Cgroup1', displayName: 'Team Dev', kind: 'group', count: 1 });
    });

    it('records a room (no name) with kind room', () => {
      recordDeniedConversation(A, 'Rroom1', 'room', undefined, 1000);
      expect(getPendingSenders(A)[0]).toMatchObject({ userId: 'Rroom1', kind: 'room' });
      expect(getPendingSenders(A)[0].displayName).toBeUndefined();
    });

    it('dedups a group by id, backfilling the name on a later resolve', () => {
      recordDeniedConversation(A, 'Cg', 'group', undefined, 1000);
      recordDeniedConversation(A, 'Cg', 'group', 'Family', 2000);
      const list = getPendingSenders(A);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ count: 2, displayName: 'Family', kind: 'group' });
    });

    it('users and groups coexist in one knock list, tagged by kind', () => {
      recordDeniedSender(A, 'Ualice', 'Alice', 1000);
      recordDeniedConversation(A, 'Cteam', 'group', 'Team', 2000);
      const byId = Object.fromEntries(getPendingSenders(A).map((s) => [s.userId, s.kind]));
      expect(byId).toEqual({ Ualice: 'user', Cteam: 'group' });
    });

    it('clearPendingSender drops a group id too (after adding to groupAllowlist)', () => {
      recordDeniedConversation(A, 'Cteam', 'group', 'Team', 1);
      clearPendingSender(A, 'Cteam');
      expect(getPendingSenders(A)).toHaveLength(0);
    });
  });

  describe('pairing code', () => {
    it('generatePairingCode is 6 uppercase hex', () => {
      for (let i = 0; i < 50; i++) {
        expect(generatePairingCode()).toMatch(/^[0-9A-F]{6}$/);
      }
    });

    it('returns true (wasNew) on first contact, false on dedup', () => {
      expect(recordDeniedSender(A, 'Ualice', undefined, 1000, 'ABC123')).toBe(true);
      expect(recordDeniedSender(A, 'Ualice', undefined, 2000, 'ZZZ999')).toBe(false);
    });

    it('sets code on create and never overwrites it on dedup', () => {
      recordDeniedSender(A, 'Ualice', undefined, 1000, 'ABC123');
      recordDeniedSender(A, 'Ualice', 'Alice', 2000, 'ZZZ999');
      expect(getPendingSender(A, 'Ualice')?.code).toBe('ABC123');
    });

    it('stores a code for group/room entries too', () => {
      expect(recordDeniedConversation(A, 'Cteam', 'group', undefined, 1000, 'DEAD01')).toBe(true);
      expect(getPendingSender(A, 'Cteam')?.code).toBe('DEAD01');
    });

    it('getPendingSender returns undefined for an unknown id', () => {
      expect(getPendingSender(A, 'Unope')).toBeUndefined();
    });

    it('leaves code undefined when none is passed (pairing off)', () => {
      recordDeniedSender(A, 'Ubob', 'Bob', 1000);
      expect(getPendingSender(A, 'Ubob')?.code).toBeUndefined();
    });
  });
});
