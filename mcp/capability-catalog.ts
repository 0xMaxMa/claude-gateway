/** Metadata only. Never initialize channel receivers or call an MCP tool. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { gatewayModules } from './modules';
import { AGENT_TASK_TOOLS, WORKER_REPORT_TOOLS } from './tools/tasks/module';

type Entry = {
  name: string;
  description: string;
  server: string;
  status: string;
  via: 'agent' | 'worker' | 'unavailable';
};
const entries: Entry[] = [];
const servers: Array<{ name: string; status: string }> = [];
const chunks: Buffer[] = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 4 * 1024 * 1024) throw Error('CATALOG_INPUT_TOO_LARGE');
  chunks.push(Buffer.from(chunk));
}
const input = JSON.parse(Buffer.concat(chunks).toString());
// Mirror the worker module gates for metadata, without issuing a usable ticket.
const profileKeys = [
  'GATEWAY_ORCHESTRATION_ROLE',
  'GATEWAY_ORCHESTRATION_MEDIA',
  'GATEWAY_ORCHESTRATION_TICKET_FILE',
];
const original = profileKeys.map((key) => process.env[key]);
Object.assign(process.env, {
  GATEWAY_ORCHESTRATION_ROLE: 'worker',
  GATEWAY_ORCHESTRATION_MEDIA: 'true',
  GATEWAY_ORCHESTRATION_TICKET_FILE: '/capability-discovery-no-execution',
});
const worker = new Set(
  gatewayModules('worker', true).flatMap((m) =>
    m.isEnabled() ? m.getTools().map((t) => t.name) : []
  )
);
for (const module of gatewayModules()) {
  let enabled = false;
  try {
    enabled = module.isEnabled();
  } catch {
    /* Unavailable, not absent. */
  }
  for (const tool of module.getTools())
    entries.push({
      name: `mcp__gateway__${tool.name}`,
      description: tool.description,
      server: 'gateway',
      status: !enabled
        ? 'not_configured'
        : worker.has(tool.name)
          ? tool.name.startsWith('memory_shared_')
            ? 'requires_memory_permission'
            : 'available'
          : 'not_exposed_to_workers',
      via:
        enabled && ['memory_search', 'memory_get'].includes(tool.name)
          ? 'agent'
          : enabled && worker.has(tool.name)
            ? 'worker'
            : 'unavailable',
    });
}
for (const tool of AGENT_TASK_TOOLS)
  entries.push({
    name: `mcp__gateway__${tool.name}`,
    description: tool.description,
    server: 'gateway',
    status:
      tool.name === 'conversation_intake'
        ? 'requires_semantic_intake'
        : 'available',
    via: 'agent',
  });
for (const tool of WORKER_REPORT_TOOLS)
  entries.push({
    name: `mcp__gateway__${tool.name}`,
    description: tool.description,
    server: 'gateway',
    status:
      tool.name === 'task_memory_append'
        ? 'requires_memory_permission'
        : 'available',
    via: 'worker',
  });
profileKeys.forEach((key, i) => {
  if (original[i] === undefined) delete process.env[key];
  else process.env[key] = original[i];
});
servers.push({ name: 'gateway', status: 'available' });
for (const [name, value] of Object.entries(input.servers ?? {})) {
  const config = value as {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  const client = new Client({
    name: 'gateway-capability-discovery',
    version: '1',
  });
  let transport:
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport
    | undefined;
  const timeout = setTimeout(() => {
    void client.close();
  }, 5000);
  try {
    if (config.command)
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (e): e is [string, string] => typeof e[1] === 'string'
            )
          ),
          ...config.env,
        },
        stderr: 'ignore',
      });
    else if (config.url)
      transport =
        config.type === 'sse'
          ? new SSEClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers },
            })
          : new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers },
            });
    else throw Error('INVALID_MCP_CONFIG');
    await client.connect(transport, { timeout: 5000 });
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        timeout: 5000,
      });
      for (const tool of result.tools)
        entries.push({
          name: `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          description: tool.description ?? '',
          server: name,
          status: 'available',
          via: 'worker',
        });
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) throw Error('CATALOG_CURSOR_LOOP');
      if (cursor) seen.add(cursor);
      if (Buffer.byteLength(JSON.stringify(entries)) > 3 * 1024 * 1024)
        throw Error('CATALOG_TOO_LARGE');
    } while (cursor);
    servers.push({ name, status: 'available' });
  } catch {
    // Do not publish connection errors: URLs/headers may include secrets.
    for (const entry of entries)
      if (entry.server === name) {
        entry.status = 'discovery_incomplete';
        entry.via = 'unavailable';
      }
    const observed = input.observed?.find(
      (s: { name: string; status: string }) =>
        s.name === name && s.status === 'connected'
    );
    if (observed) {
      for (const tool of observed.tools ?? []) {
        const fullName = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__${String(tool.name).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (!entries.some((e) => e.name === fullName))
          entries.push({
            name: fullName,
            description:
              tool.description ||
              'Tool reported by the Claude Code MCP runtime; detailed metadata unavailable.',
            server: name,
            status: 'available',
            via: 'worker',
          });
        else
          for (const entry of entries)
            if (entry.name === fullName) {
              entry.status = 'available';
              entry.via = 'worker';
            }
      }
      servers.push({ name, status: 'available_names_only' });
    } else servers.push({ name, status: 'discovery_unavailable' });
  } finally {
    clearTimeout(timeout);
    await client.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}
process.stdout.write(
  JSON.stringify({ entries, servers, observedAt: new Date().toISOString() })
);
