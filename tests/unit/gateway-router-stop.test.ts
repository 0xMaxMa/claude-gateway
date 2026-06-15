import * as http from 'http';
import type { AddressInfo } from 'net';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentRunner } from '../../src/agent/runner';
import type { AgentConfig } from '../../src/types';

// --------------------------------------------------------------------------
// GatewayRouter.stop() — graceful shutdown must not hang on keep-alive sockets
//
// Regression for the "Ctrl+C twice" bug: the dashboard polls every 3s/6s and
// holds keep-alive HTTP connections open. server.close() only stops accepting
// new connections and waits for existing ones to drain, so without an explicit
// closeAllConnections() the first SIGINT hung and a second was needed.
// --------------------------------------------------------------------------
describe('GatewayRouter.stop() — graceful shutdown', () => {
  function newRouter(): GatewayRouter {
    return new GatewayRouter(
      new Map<string, AgentRunner>(),
      new Map<string, AgentConfig>(),
    );
  }

  it('GR-STOP-1: resolves promptly even with a live keep-alive HTTP connection', async () => {
    const router = newRouter();
    await router.start(0);

    // Reach the underlying http.Server to discover the random bound port.
    const server = (router as unknown as { server: http.Server }).server;
    const port = (server.address() as AddressInfo).port;

    // Open a keep-alive connection and complete one request. The agent keeps
    // the underlying socket open afterwards, which is exactly what the dashboard
    // polling does — and what made server.close() hang before the fix.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', agent }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', reject);
    });

    // stop() must resolve quickly; if closeAllConnections() were missing this
    // would hang until the keep-alive socket idle-timed out (and the test would
    // fail on the race timeout below).
    const stopped = await Promise.race([
      router.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    agent.destroy();
    expect(stopped).toBe('stopped');
  });

  it('GR-STOP-2: resolves cleanly when there are no open connections', async () => {
    const router = newRouter();
    await router.start(0);

    const stopped = await Promise.race([
      router.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2000)),
    ]);

    expect(stopped).toBe('stopped');
  });
});
