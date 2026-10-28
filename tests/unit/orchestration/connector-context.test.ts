import { connectedConnectorsContext } from '../../../src/orchestration/connector-context';
import { resolveEnabledConnectors } from '../../../src/connectors/resolve';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
jest.mock('../../../src/connectors/resolve', () => ({ resolveEnabledConnectors: jest.fn() }));
jest.mock('../../../src/orchestration/browser-routing', () => ({
  remoteBrowserIds: (_entries: unknown, enabled: Record<string, unknown>) => Object.keys(enabled).filter(id => id === 'remote-browser'),
}));
const resolved = resolveEnabledConnectors as jest.Mock;

const gateway = {
  gateway: {
    customConnectors: {
      'google-calendar': { label: 'Google Calendar', description: 'List, create, and manage calendar events.', config: {}, secretNames: ['access_token'] },
      gmail: { label: 'Gmail', description: 'x'.repeat(400), config: {}, secretNames: ['access_token'] },
      'remote-browser': { label: 'Remote Browser', config: {}, secretNames: [] },
    },
  },
} as unknown as GatewayConfig;

// Live E2E (chat 6c790831): Google Calendar was connected and its sidecar ready, yet the
// decision told the user it had no calendar access without ever calling capabilities_list.
test('lists the connected connectors so the decision delegates instead of denying access', () => {
  resolved.mockReturnValue({
    gmail: { headers: { Authorization: 'Bearer ya29.secret' } },
    'google-calendar': { url: 'http://127.0.0.1:5000/mcp', headers: { Authorization: 'Bearer ya29.secret' } },
    'remote-browser': { url: 'http://127.0.0.1:5001/mcp' },
  });
  const text = connectedConnectorsContext({ id: 'a' } as AgentConfig, gateway);
  expect(text).toContain('"id":"gmail","label":"Gmail"');
  expect(text).toContain('"id":"google-calendar","label":"Google Calendar","description":"List, create, and manage calendar events."');
  expect(text).toContain('task_spawn to default-worker');
  expect(text).toContain('Never tell the user a listed connector is not connected');
  expect(text).not.toContain('remote-browser');
  expect(text).not.toContain('ya29');
  expect(text).not.toContain('127.0.0.1');
  expect(text).not.toContain('x'.repeat(200));
});

test('says nothing when no connector resolves (disconnected, paused or scoped out)', () => {
  resolved.mockReturnValue({});
  expect(connectedConnectorsContext({ id: 'a' } as AgentConfig, gateway)).toBe('');
  resolved.mockReturnValue({ 'remote-browser': {} });
  expect(connectedConnectorsContext({ id: 'a' } as AgentConfig, gateway)).toBe('');
});

test('container and tool-less agents do not inherit host connector availability', () => {
  resolved.mockReturnValue({ gmail: {} });
  expect(connectedConnectorsContext({ id: 'a', type: 'app-agent' } as AgentConfig, gateway)).toBe('');
  expect(connectedConnectorsContext({ id: 'a' } as AgentConfig, gateway, false)).toBe('');
  expect(connectedConnectorsContext({ id: 'a', allow_tools: false } as AgentConfig, gateway)).toBe('');
});

test('caps a long label like a long description', () => {
  resolved.mockReturnValue({ gmail: {} });
  const long = { gateway: { customConnectors: { gmail: { label: 'Gmail ' + 'x'.repeat(20_000), config: {}, secretNames: [] } } } } as unknown as GatewayConfig;
  const text = connectedConnectorsContext({ id: 'a' } as AgentConfig, long);
  expect(text).toContain('"label":"Gmail xxx');
  expect(text.length).toBeLessThan(2000);
});
