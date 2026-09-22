import { dashboardProviderWait, readDashboardProviderWait } from '../../src/orchestration/dashboard-provider-wait';
import { providerWaitingHtml } from '../../src/ui/dashboard-presentation';

const waiting = { state: 'waiting_for_provider', reason: 'rate_limit', nextRetryAt: 2000000000000, requiresConfigurationChange: false };

describe('dashboard provider waiting annotation', () => {
  it('reads older databases without querying an absent table', () => {
    const get = jest.fn(() => { throw new Error('no such table: provider_waits'); });
    expect(readDashboardProviderWait(get, false, 'session:example')).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
  it('projects queued tasks and sessions but ignores stale waits on active or terminal tasks', () => {
    const get = jest.fn(() => ({ waiting_json: JSON.stringify(waiting) }));
    expect(readDashboardProviderWait(get, true, 'task-id', 'queued')).toEqual(waiting);
    expect(readDashboardProviderWait(get, true, 'session:example')).toEqual(waiting);
    get.mockClear();
    for (const state of ['running', 'completed', 'failed', 'cancelled']) expect(readDashboardProviderWait(get, true, 'task-id', state)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
  it('omits scope, identity and untrusted reason text from public data', () => {
    const projected = dashboardProviderWait(JSON.stringify({ ...waiting, scope: 'private-account-hash', episode: 'private-episode', reason: '<script>private</script>', rawError: 'secret-token' }));
    expect(projected).toEqual({ ...waiting, reason: 'unknown' });
    const html = providerWaitingHtml(projected);
    expect(html).toContain('Waiting for provider');
    expect(html).toContain('Provider request paused');
    expect(html).not.toMatch(/private|secret-token|<script>/);
  });
  it('shows safe retry timing or an explicit configuration requirement', () => {
    expect(providerWaitingHtml(waiting)).toContain('Next retry 2033-05-18T03:33:20.000Z');
    const blocked = providerWaitingHtml({ ...waiting, requiresConfigurationChange: true });
    expect(blocked).toContain('Configuration change required');
    expect(blocked).not.toContain('Next retry');
  });
  it('ignores corrupt records and invalid timestamps', () => {
    expect(dashboardProviderWait('{')).toBeUndefined();
    expect(dashboardProviderWait({ state: 'completed' })).toBeUndefined();
    expect(dashboardProviderWait({ ...waiting, nextRetryAt: 1e20 })).not.toHaveProperty('nextRetryAt');
    expect(providerWaitingHtml(null)).toBe('');
  });
});
