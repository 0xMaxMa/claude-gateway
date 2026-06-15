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

  // Race a promise against a deadline, clearing the timer when the promise wins.
  // A leaked setTimeout would keep firing after the test finished (Jest open-handle
  // warnings / cross-test bleed). The deadline only needs to be far above the real
  // resolve time (~ms) to flag a genuine hang, so it's generous to avoid CI flakiness
  // under CPU contention rather than tight.
  async function resolvesWithin<T>(p: Promise<T>, ms: number): Promise<'ok' | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p.then(() => 'ok' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // The fix resolves in single-digit ms; this ceiling only catches a true hang.
  const STOP_DEADLINE_MS = 5000;

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

    // stop() must resolve quickly; without closeAllConnections() this would hang
    // until the keep-alive socket idle-timed out (and fail the deadline below).
    const result = await resolvesWithin(router.stop(), STOP_DEADLINE_MS);

    agent.destroy();
    expect(result).toBe('ok');
  });

  it('GR-STOP-2: resolves cleanly when there are no open connections', async () => {
    const router = newRouter();
    await router.start(0);

    const result = await resolvesWithin(router.stop(), STOP_DEADLINE_MS);

    expect(result).toBe('ok');
  });
});
