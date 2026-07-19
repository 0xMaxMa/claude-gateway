/**
 * Unit tests for the KEY-SELECTION half of the public media route — the logic in
 * GatewayRouter.resolveMediaTokenKey(token): base64url-decode the token's UNTRUSTED
 * `payload.a`, then pick the signing key from config.gateway.api.keys using the same
 * precedence as SessionProcess.findApiKeyForAgent (agent-scoped → wildcard '*' → admin).
 * The chosen key is then handed to verifyMediaToken, whose HMAC is what makes `a`
 * trustworthy: claiming an `a` that selects the WRONG key must fail verification.
 *
 * WHY THIS IS A REPLICATED PREDICATE, NOT A supertest DRIVE OF THE REAL ROUTE:
 *   resolveMediaTokenKey is a private method on GatewayRouter, and importing
 *   GatewayRouter transitively loads src/api/router.ts → src/agent/runner.ts →
 *   src/history/db.ts, which does `require('node:sqlite')`. That builtin is absent
 *   from the Node build used by this test runtime (v22.12.0), so the module throws
 *   at load — the same known issue that breaks tests/unit/api-router.test.ts. We
 *   therefore replicate the exact selection predicate + base64url decode here and
 *   drive the REAL crypto (sign/verify imported from src/api/media-sign.ts). This
 *   proves the two security properties end-to-end: (1) sign(agentId)↔resolve(a)
 *   determinism — the same key is chosen on both sides for a given agent, and
 *   (2) a token that claims an `a` resolving to a different key fails verification.
 *
 * The replica below is a byte-for-byte copy of resolveMediaTokenKey's body
 * (gateway-router.ts) — keep it in sync if that method changes.
 */
import { signMediaToken, verifyMediaToken } from '../../src/api/media-sign';

// Mirror of the ApiKey fields the predicate reads (src/types.ts).
type TestApiKey = { key: string; agents?: string[] | '*'; admin?: boolean };

// ── exact replica of GatewayRouter.resolveMediaTokenKey ──────────────────────
function resolveMediaTokenKey(token: string, keys: TestApiKey[]): string {
  const dot = token.indexOf('.');
  if (dot <= 0) return '';
  let agentId: string;
  try {
    const bodyPart = token.slice(0, dot);
    const pad = bodyPart.length % 4 === 0 ? '' : '='.repeat(4 - (bodyPart.length % 4));
    const json = Buffer.from(
      bodyPart.replace(/-/g, '+').replace(/_/g, '/') + pad,
      'base64',
    ).toString('utf-8');
    const parsed = JSON.parse(json) as { a?: unknown };
    if (typeof parsed.a !== 'string' || !parsed.a) return '';
    agentId = parsed.a;
  } catch {
    return '';
  }
  const match = keys.find(k =>
    (Array.isArray(k.agents) && k.agents.includes(agentId)) ||
    k.agents === '*' ||
    k.admin,
  );
  return match?.key ?? '';
}

// The full route contract: pick the key from `a`, then verify. Returns the payload
// (route would stream the file / 404) or null (route → 403).
function resolveAndVerify(token: string, keys: TestApiKey[]) {
  return verifyMediaToken(token, resolveMediaTokenKey(token, keys));
}

const AGENT_KEY: TestApiKey = { key: 'key-agentA', agents: ['agentA'] };
const WILDCARD_KEY: TestApiKey = { key: 'key-wildcard', agents: '*' };
const ADMIN_KEY: TestApiKey = { key: 'key-admin', admin: true };
const sign = (a: string, secret: string) =>
  signMediaToken({ a, p: 'media/c/f.png', e: Date.now() + 60_000 }, secret);

describe('resolveMediaTokenKey() — key selection precedence', () => {
  test('agent-scoped key is chosen when a matches its agents list', () => {
    const keys = [AGENT_KEY, WILDCARD_KEY, ADMIN_KEY];
    expect(resolveMediaTokenKey(sign('agentA', AGENT_KEY.key), keys)).toBe(AGENT_KEY.key);
  });

  test('wildcard "*" key is chosen for an agent no scoped key names', () => {
    const keys = [AGENT_KEY, WILDCARD_KEY];
    expect(resolveMediaTokenKey(sign('agentZ', WILDCARD_KEY.key), keys)).toBe(WILDCARD_KEY.key);
  });

  test('admin key is chosen when neither a scoped nor a wildcard key matches', () => {
    const keys = [AGENT_KEY, ADMIN_KEY];
    expect(resolveMediaTokenKey(sign('agentZ', ADMIN_KEY.key), keys)).toBe(ADMIN_KEY.key);
  });

  test('no matching key (only other agents scoped) → "" ', () => {
    const keys: TestApiKey[] = [{ key: 'key-other', agents: ['agentB'] }];
    expect(resolveMediaTokenKey(sign('agentA', 'whatever'), keys)).toBe('');
  });

  test('empty config → "" ', () => {
    expect(resolveMediaTokenKey(sign('agentA', 'whatever'), [])).toBe('');
  });

  test('malformed token (no ".") → "" (never touches the key list)', () => {
    expect(resolveMediaTokenKey('garbage', [WILDCARD_KEY])).toBe('');
  });

  test('token body without a string `a` → "" ', () => {
    const body = Buffer.from(JSON.stringify({ p: 'x', e: 1 }), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(resolveMediaTokenKey(`${body}.AAAA`, [WILDCARD_KEY])).toBe('');
  });
});

describe('resolve ↔ verify — the route contract (403 vs serve)', () => {
  test('token signed with agentA key + a=agentA verifies (route would serve, NOT 403)', () => {
    const keys = [AGENT_KEY, WILDCARD_KEY, ADMIN_KEY];
    const token = sign('agentA', AGENT_KEY.key);
    expect(resolveAndVerify(token, keys)).not.toBeNull();
  });

  test('token whose a selects the wildcard key verifies', () => {
    const token = sign('agentZ', WILDCARD_KEY.key);
    expect(resolveAndVerify(token, [AGENT_KEY, WILDCARD_KEY])).not.toBeNull();
  });

  test('token whose a selects the admin key verifies', () => {
    const token = sign('agentZ', ADMIN_KEY.key);
    expect(resolveAndVerify(token, [AGENT_KEY, ADMIN_KEY])).not.toBeNull();
  });

  test('WRONG signing key (signed with a key that is not the one a resolves to) → null (403)', () => {
    // Signed with the admin key but a=agentA, which resolves to the agent-scoped
    // key. Selected key ≠ signing key ⇒ HMAC mismatch ⇒ verify null.
    const keys = [AGENT_KEY, ADMIN_KEY];
    const token = sign('agentA', ADMIN_KEY.key);
    expect(resolveMediaTokenKey(token, keys)).toBe(AGENT_KEY.key); // a selected the scoped key
    expect(resolveAndVerify(token, keys)).toBeNull();
  });

  test('security property: sign(K1) but claim an a that resolves to K2≠K1 → verify fails', () => {
    // Attacker holds WILDCARD_KEY (K1) and wants to impersonate agentA, which is
    // served by the agent-scoped key (K2). They sign with K1 and set a=agentA.
    // resolveMediaTokenKey's .find hits K2 first (it matches agentA), verify(K2) fails.
    const K1 = WILDCARD_KEY;
    const K2 = AGENT_KEY;
    const keys = [K2, K1]; // .find scans in array order; K2 matches agentA first
    const forged = signMediaToken({ a: 'agentA', p: 'media/c/f.png', e: Date.now() + 60_000 }, K1.key);
    expect(resolveMediaTokenKey(forged, keys)).toBe(K2.key);
    expect(K2.key).not.toBe(K1.key);
    expect(resolveAndVerify(forged, keys)).toBeNull();
  });

  test('no matching key → verify against "" → null (403)', () => {
    const keys: TestApiKey[] = [{ key: 'key-other', agents: ['agentB'] }];
    const token = sign('agentA', 'anything');
    expect(resolveAndVerify(token, keys)).toBeNull();
  });

  test('empty config → null (403)', () => {
    const token = sign('agentA', 'anything');
    expect(resolveAndVerify(token, [])).toBeNull();
  });

  test('determinism: the same agent selects the same key across independent tokens', () => {
    const keys = [AGENT_KEY, WILDCARD_KEY, ADMIN_KEY];
    const k1 = resolveMediaTokenKey(sign('agentA', AGENT_KEY.key), keys);
    const k2 = resolveMediaTokenKey(sign('agentA', AGENT_KEY.key), keys);
    expect(k1).toBe(k2);
    expect(k1).toBe(AGENT_KEY.key);
  });
});
