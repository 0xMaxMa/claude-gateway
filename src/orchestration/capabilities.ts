import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { resolveEnabledConnectors } from '../connectors/resolve';
import { isReservedConnectorId } from '../connectors/custom';
import { pathWithNativeBin, resolveClaudeBin } from '../session/claude-bin';
import { DEFAULT_WORKER_TOOLS } from '../session/runtime-profile';
import { resolveOrchestrationConfig } from './config';
import { containerTaskTools } from './bridge';
import { OrchestrationError } from './types';
import type { AgentConfig, GatewayConfig } from '../types';
import type { SkillRegistry } from '../skills';

function terminateCatalogProcess(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = 'SIGTERM'
) {
  try {
    if (process.platform === 'linux' && child.pid)
      process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* Already exited. */
  }
}

export interface CapabilityEntry {
  name: string;
  description: string;
  server: string;
  status: string;
  via: string;
}
export interface CapabilitySnapshot {
  entries: CapabilityEntry[];
  servers: Array<{ name: string; status: string }>;
  observedAt: string;
}

export interface ObservedMcpServer {
  name: string;
  status: string;
  tools: Array<{ name: string; description: string }>;
}

/** Obtain CLI-resolved MCP configs (including enabled plugins), without a user turn. */
export function probeMcpConfiguration(
  command: string,
  args: string[],
  cwd: string,
  onObserved?: (servers: ObservedMcpServer[]) => void
): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform === 'linux',
      env: {
        ...process.env,
        ...(pathWithNativeBin() ? { PATH: pathWithNativeBin() } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '',
      bytes = 0,
      value: Record<string, unknown> | undefined;
    let failure: Error | undefined,
      stopped = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined,
      polls = 0;
    const stop = (error?: Error) => {
      if (stopped) return;
      stopped = true;
      failure = error;
      if (retry) clearTimeout(retry);
      clearTimeout(timer);
      child.stdin.end();
      terminateCatalogProcess(child);
      kill = setTimeout(() => terminateCatalogProcess(child, 'SIGKILL'), 1000);
      kill.unref();
    };
    const timer = setTimeout(
      () => stop(Error('CAPABILITY_DISCOVERY_TIMEOUT')),
      10000
    );
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.on('error', () => {
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
      if (kill) clearTimeout(kill);
      reject(Error('CAPABILITY_DISCOVERY_UNAVAILABLE'));
    });
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) {
        stop(Error('CAPABILITY_DISCOVERY_TOO_LARGE'));
        return;
      }
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type !== 'control_response') continue;
          if (event.response?.subtype !== 'success') {
            stop(Error('CAPABILITY_DISCOVERY_UNAVAILABLE'));
            return;
          }
          if (event.response.request_id === 'catalog-init')
            child.stdin.write(
              JSON.stringify({
                type: 'control_request',
                request_id: 'catalog-mcp',
                request: { subtype: 'mcp_status' },
              }) + '\n'
            );
          if (event.response.request_id === 'catalog-mcp') {
            const servers = event.response.response?.mcpServers;
            if (!Array.isArray(servers)) throw Error('INVALID_CATALOG');
            if (servers.some((s) => s.status === 'pending') && polls++ < 6) {
              retry = setTimeout(
                () =>
                  child.stdin.write(
                    JSON.stringify({
                      type: 'control_request',
                      request_id: 'catalog-mcp',
                      request: { subtype: 'mcp_status' },
                    }) + '\n'
                  ),
                400
              );
              return;
            }
            onObserved?.(
              servers
                .filter(
                  (s) =>
                    typeof s.name === 'string' && !isReservedConnectorId(s.name)
                )
                .map((s) => ({
                  name: s.name,
                  status: typeof s.status === 'string' ? s.status : 'unknown',
                  tools: Array.isArray(s.tools)
                    ? s.tools
                        .filter(
                          (t: unknown) =>
                            t &&
                            typeof (t as { name?: unknown }).name === 'string'
                        )
                        .map((t: { name: string; description?: string }) => ({
                          name: t.name,
                          description:
                            typeof t.description === 'string'
                              ? t.description
                              : '',
                        }))
                    : [],
                }))
            );

            value = Object.fromEntries(
              servers
                .filter(
                  (s) =>
                    typeof s.name === 'string' &&
                    s.config &&
                    !isReservedConnectorId(s.name)
                )
                .map((s) => [s.name, s.config])
            );
            stop();
            return;
          }
        } catch {
          stop(Error('CAPABILITY_DISCOVERY_INVALID'));
          return;
        }
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
      if (kill) clearTimeout(kill);
      terminateCatalogProcess(child, 'SIGKILL');
      if (value && !failure) resolveResult(value);
      else reject(failure ?? Error('CAPABILITY_DISCOVERY_UNAVAILABLE'));
    });
    child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'catalog-init',
        request: { subtype: 'initialize' },
      }) + '\n'
    );
  });
}

export function readCapabilityPage(
  snapshot: CapabilitySnapshot,
  registry: SkillRegistry | undefined,
  args: Record<string, unknown>
) {
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new OrchestrationError('INVALID_CAPABILITY_OFFSET');
  const skills: CapabilityEntry[] = [...(registry?.skills.entries() ?? [])].map(
    ([name, skill]) => ({
      name,
      description: skill.description,
      server: `skill:${skill.source}`,
      status: skill.userInvocable ? 'available' : 'automatic_only',
      via: skill.userInvocable ? 'skill-worker' : 'runtime',
    })
  );
  for (const skill of registry?.cliSkills ?? [])
    if (!skills.some((s) => s.name === skill.name))
      skills.push({
        name: skill.name,
        description: skill.description,
        server: 'skill:claude-code',
        status: 'available',
        via: 'skill-worker',
      });
  const all = [...snapshot.entries, ...skills].filter(
    (e) =>
      !query ||
      `${e.name} ${e.description} ${e.server}`.toLowerCase().includes(query)
  );
  all.sort(
    (a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name)
  );
  const version = createHash('sha256')
    .update(
      JSON.stringify({
        entries: all,
        servers: snapshot.servers,
        skillDiscovery: registry?.cliDiscoveryError ?? '',
      })
    )
    .digest('hex');
  if (
    (offset > 0 && typeof args.catalog_version !== 'string') ||
    (args.catalog_version !== undefined && args.catalog_version !== version)
  )
    throw new OrchestrationError(
      'CAPABILITY_CATALOG_CHANGED',
      'Restart pagination from offset 0; the catalog changed.'
    );
  // Page by byte budget too. A single large description is preserved on its own page.
  const entries: CapabilityEntry[] = [];
  let bytes = 0;
  for (const entry of all.slice(offset, offset + 50)) {
    const n = Buffer.byteLength(JSON.stringify(entry));
    if (entries.length && bytes + n > 24000) break;
    entries.push(entry);
    bytes += n;
  }
  const disabled = snapshot.servers.some(
    (s) => s.name === 'execution' && s.status === 'disabled_for_agent'
  );
  if (disabled)
    for (const entry of entries) {
      entry.status = 'disabled_for_agent';
      entry.via = 'unavailable';
    }
  const next = offset + entries.length;
  return {
    catalog_version: version,
    observedAt: snapshot.observedAt,
    servers: snapshot.servers,
    skillDiscovery: registry?.cliDiscoveryError ? 'unavailable' : 'available',
    entries,
    total: all.length,
    next_offset: next < all.length ? next : null,
    note: 'Metadata describes capabilities, not authorization to execute or proof of working credentials, credit, or remote-device access. Unavailable discovery is not proof that a server has no tools. Fetch every page before claiming this is a complete list.',
  };
}

let discoveryActive = false;

export class CapabilityCatalog {
  private cache?: {
    key: string;
    until: number;
    value: Promise<CapabilitySnapshot>;
  };
  constructor(
    private readonly agent: AgentConfig,
    private readonly gateway: GatewayConfig
  ) {}
  async snapshot(): Promise<CapabilitySnapshot> {
    const now = new Date().toISOString();
    if (this.agent.allow_tools === false)
      return {
        entries: [],
        servers: [{ name: 'execution', status: 'disabled_for_agent' }],
        observedAt: now,
      };
    if (this.agent.type === 'app-agent')
      return {
        observedAt: now,
        servers: [{ name: 'gateway', status: 'container_only' }],
        entries: [
          ...DEFAULT_WORKER_TOOLS.map(
            (name) => ({
              name,
              description: 'Claude Code tool inside the app container only.',
              server: 'claude-code',
              status: 'available',
              via: 'worker',
            })
          ),
          ...containerTaskTools('agent').map((t) => ({
            name: `mcp__gateway__${t.name}`,
            description: t.description,
            server: 'gateway',
            status: 'available',
            via: 'agent',
          })),
          ...containerTaskTools('worker').map((t) => ({
            name: `mcp__gateway__${t.name}`,
            description: t.description,
            server: 'gateway',
            status: 'available',
            via: 'worker',
          })),
        ],
      };
    const host =
      resolveOrchestrationConfig(this.agent.orchestration).tasks
        .workspaceMode === 'host';
    const resolved = host
      ? resolveEnabledConnectors(
          this.agent,
          this.gateway.gateway.customConnectors,
          this.gateway.gateway.connectorsDefaultEnabled ?? true
        )
      : {};
    const servers = Object.fromEntries(
      Object.entries(resolved).filter(([id]) => !isReservedConnectorId(id))
    );
    const key = createHash('sha256')
      .update(
        JSON.stringify({ host, servers, agent: this.agent, env: process.env })
      )
      .digest('hex');
    if (this.cache?.key === key && this.cache.until > Date.now())
      return this.cache.value;
    // One metadata subprocess tree at a time across agents, with no wait queue
    // that could hold a conversational turn behind other agents' discovery.
    if (discoveryActive)
      return {
        entries: [],
        servers: [
          { name: 'runtime', status: 'discovery_pending' },
          ...Object.keys(servers).map((name) => ({
            name,
            status: 'discovery_pending',
          })),
        ],
        observedAt: now,
      };
    discoveryActive = true;
    const value = this.discover(host, servers)
      .finally(() => {
        discoveryActive = false;
      })
      .catch(() => ({
        entries: [],
        servers: [
          { name: 'runtime', status: 'discovery_unavailable' },
          ...Object.keys(servers).map((name) => ({
            name,
            status: 'discovery_unavailable',
          })),
        ],
        observedAt: now,
      }));
    this.cache = { key, until: Date.now() + 30000, value };
    return value;
  }
  private async discover(
    host: boolean,
    connectors: Record<string, unknown>
  ): Promise<CapabilitySnapshot> {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-capabilities-'));
    try {
      let servers = connectors;
      let cliFailed = false;
      let observed: ObservedMcpServer[] = [];
      if (host) {
        const file = join(directory, 'mcp.json');
        await writeFile(file, JSON.stringify({ mcpServers: connectors }), {
          mode: 0o600,
        });
        const binary = process.env.CLAUDE_BIN || resolveClaudeBin().bin;
        const [command, ...prefix] = binary.split(' ');
        try {
          servers = {
            ...(await probeMcpConfiguration(
              command,
              [
                ...prefix,
                '-p',
                '--input-format',
                'stream-json',
                '--output-format',
                'stream-json',
                '--verbose',
                '--mcp-config',
                file,
                '--settings',
                '{"disableAllHooks":true}',
                '--tools',
                'default',
              ],
              this.agent.orchestration?.tasks?.projectRoot ||
                this.agent.workspace,
              (value) => {
                observed = value;
              }
            )),
            ...connectors,
          };
        } catch {
          cliFailed = true;
        }
      }
      const snapshot = await new Promise<CapabilitySnapshot>(
        (resolveResult, reject) => {
          const child = spawn(
            'bun',
            [resolve(__dirname, '../../mcp/capability-catalog.ts')],
            {
              cwd: this.agent.workspace,
              detached: process.platform === 'linux',
              env: {
                ...process.env,
                GATEWAY_WORKSPACE_DIR: this.agent.workspace,
                GATEWAY_ORIGIN_CHANNEL: 'api',
                GETPOD_BROWSER_URL:
                  process.env.GETPOD_BROWSER_URL ?? 'http://127.0.0.1:10880',
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          );
          const chunks: Buffer[] = [];
          let bytes = 0;
          const timer = setTimeout(() => {
            terminateCatalogProcess(child, 'SIGKILL');
            reject(Error('CAPABILITY_DISCOVERY_TIMEOUT'));
          }, 30000);
          child.stdin.on('error', () => {});
          child.stderr.on('data', () => {});
          child.stdout.on('data', (b) => {
            bytes += b.length;
            if (bytes > 4 * 1024 * 1024) {
              terminateCatalogProcess(child, 'SIGKILL');
              reject(Error('CAPABILITY_DISCOVERY_TOO_LARGE'));
            } else chunks.push(b);
          });
          child.on('error', () => {
            clearTimeout(timer);
            reject(Error('CAPABILITY_DISCOVERY_UNAVAILABLE'));
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            terminateCatalogProcess(child, 'SIGKILL');
            try {
              if (code !== 0) throw Error();
              resolveResult(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              reject(Error('CAPABILITY_DISCOVERY_UNAVAILABLE'));
            }
          });
          child.stdin.end(JSON.stringify({ servers, observed }));
        }
      );
      if (cliFailed)
        snapshot.servers.push({
          name: 'claude-code-mcp',
          status: 'discovery_unavailable',
        });
      snapshot.entries.unshift({
        name: host
          ? 'Claude Code default tools'
          : DEFAULT_WORKER_TOOLS.join(', '),
        description: host
          ? 'Native Claude Code execution tools, resolved by the worker runtime. This entry is a tool set, not an exhaustive list of individual native names.'
          : 'Native tools restricted by the isolated worker profile.',
        server: 'claude-code',
        status: 'available',
        via: 'worker',
      });
      return snapshot;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
