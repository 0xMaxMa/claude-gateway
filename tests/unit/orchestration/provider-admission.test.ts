import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderAdmissionStore, PROVIDER_ADMISSION_DEFAULTS as policy, providerFailure, ProviderPermit } from '../../../src/orchestration/provider-admission';
import { providerErrorMetadata } from '../../../src/orchestration/provider-error-metadata';

const failure = {reason:'server' as const};
function permit(store: ProviderAdmissionStore, scope = 'route'): ProviderPermit {
  const result = store.acquire(scope, policy);
  expect(result.permit).toBeDefined();
  return result.permit!;
}
function trip(store: ProviderAdmissionStore, scope = 'route'): void {
  for (let i = 0; i < 3; i++) store.settle(permit(store, scope), failure, policy);
}

test('new notifications and sessions share a durable cooldown and one half-open probe', () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-admission-'));
  let now = 1000;
  let first = new ProviderAdmissionStore(join(root, 'state.db'), () => now);
  const second = new ProviderAdmissionStore(join(root, 'state.db'), () => now);
  try {
    trip(first);
    for (let i = 0; i < 50; i++) expect(second.acquire('route', policy).waiting).toMatchObject({reason:'server', nextRetryAt:121000});
    expect(second.acquire('independent-account', policy).permit).toBeDefined();
    first.close(); first = new ProviderAdmissionStore(join(root, 'state.db'), () => now);
    expect(first.acquire('route', policy).waiting).toBeDefined();
    now = 121000;
    const probe = permit(first);
    expect(probe.probe).toBeTruthy();
    expect(second.acquire('route', policy).waiting).toBeDefined();
    first.settle(probe, failure, policy);
    expect(second.inspect('route', policy)?.nextRetryAt).toBe(now + 300000);
    now += 300000;
    second.settle(permit(second), failure, policy);
    expect(first.inspect('route', policy)?.nextRetryAt).toBe(now + 900000);
    expect(first.counters()).toMatchObject({suppressed:52,probes:2,outages:3});
  } finally { first.close(); second.close(); rmSync(root, {recursive:true,force:true}); }
});

test('crashed probes expire, old in-flight success is fenced, recovery resumes gradually', () => {
  let now = 0;
  const store = new ProviderAdmissionStore(':memory:', () => now);
  try {
    const old = permit(store);
    trip(store);
    store.settle(old, 'success', policy);
    expect(store.inspect('route', policy)).toBeDefined();
    now += policy.initialCooldownMs;
    const crashed = permit(store);
    now += policy.probeLeaseMs;
    const replacement = permit(store);
    store.settle(crashed, 'success', policy);
    expect(store.inspect('route', policy)).toBeDefined();
    store.settle(replacement, 'success', policy);
    expect(store.acquire('route', policy).waiting).toBeDefined();
    now += policy.recoverySpacingMs;
    store.settle(permit(store), 'success', policy);
    now += policy.recoverySpacingMs;
    store.settle(permit(store), 'success', policy);
    expect(permit(store).probe).toBeUndefined();
    expect(store.counters().recoveries).toBe(1);
  } finally { store.close(); }
});

test('authentication and unknown quota stop automatic retries until identity changes', () => {
  let now = 0;
  const store = new ProviderAdmissionStore(':memory:', () => now);
  try {
    store.settle(permit(store), {reason:'authentication',blocked:true}, policy);
    now = 30 * 86400000;
    expect(store.acquire('route', policy).waiting).toMatchObject({requiresConfigurationChange:true});
    expect(permit(store, 'rotated-credential')).toBeDefined();
    const fresh = permit(store, 'quota');
    store.settle(fresh, {reason:'quota',retryAt:now+86400000}, policy);
    expect(store.inspect('quota', policy)?.nextRetryAt).toBe(now+86400000);
  } finally { store.close(); }
});

test('healthy success does not discard subsequent failures from concurrent admissions', () => {
  const store = new ProviderAdmissionStore(':memory:');
  try {
    const concurrent = Array.from({length: 4}, () => permit(store));
    store.settle(concurrent[0], 'success', policy);
    for (const request of concurrent.slice(1)) store.settle(request, failure, policy);
    expect(store.acquire('route', policy).waiting).toMatchObject({reason: 'server'});
    // Success from that old admission batch still cannot close the new outage.
    store.settle(concurrent[0], 'success', policy);
    expect(store.inspect('route', policy)).toBeDefined();
  } finally { store.close(); }
});

test('release of a local failure does not count it as a provider failure', () => {
  let now = 0;
  const store = new ProviderAdmissionStore(':memory:', () => now);
  try {
    trip(store); now += policy.initialCooldownMs;
    const first = permit(store);
    store.release(first);
    const next = permit(store);
    expect(next.probe).not.toBe(first.probe);
    expect(store.counters().outages).toBe(1);
  } finally { store.close(); }
});

test.each([
  [{code:'TIMEOUT',timeout:{phase:'startup'}}, undefined],
  [{code:'TIMEOUT',timeout:{phase:'idle'}}, undefined],
  [{code:'TIMEOUT',timeout:{phase:'first_response'}}, 'first_response_timeout'],
  [{code:'PROVIDER_UNAVAILABLE',message:'HTTP 503'}, undefined],
  [{code:'ECONNREFUSED'}, undefined],
  [{code:'INFERENCE_FAILED',message:'invalid_api_key'}, undefined],
  [{code:'INFERENCE_FAILED',providerOrigin:true,providerCodes:['invalid_request_error'],status:400}, undefined],
  [{code:'INFERENCE_FAILED',providerOrigin:true,providerCodes:['invalid_api_key']}, 'authentication'],
  [{code:'INFERENCE_FAILED',providerOrigin:true,providerCodes:['econnreset']}, 'transport'],
  [{code:'INFERENCE_FAILED',providerOrigin:true,status:503}, 'server'],
  [{code:'INFERENCE_FAILED',providerOrigin:true,status:429}, 'rate_limit'],
  [{code:'INFERENCE_FAILED',providerOrigin:true,providerCodes:['insufficient_quota']}, 'quota'],
  [{code:'CANCELLED',providerOrigin:true,status:503}, undefined],
])('classifies structured evidence without guessing from prose: %j', (error, expected) => {
  expect(providerFailure(error)?.reason).toBe(expected);
});

test('provider reset metadata is bounded and carries no response body or credentials', () => {
  expect(providerErrorMetadata({status:429,headers:{'retry-after':'123',authorization:'secret'},message:'private',resetAt:10000},1000))
    .toEqual({status:429,retryAfterMs:123000,resetAt:10000});
  expect(providerErrorMetadata({status:'503',retryAfterMs:Infinity,resetAt:999,headers:{'retry-after':'99999999999999999999'}},1000)).toEqual({});
  expect(providerFailure({code:'INFERENCE_FAILED',providerOrigin:true,status:429,retryAfterMs:5000},1000)).toEqual({reason:'rate_limit',retryAt:6000});
});
