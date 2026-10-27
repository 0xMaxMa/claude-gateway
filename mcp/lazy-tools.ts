import type { McpToolDefinition, McpToolResult } from './types';

export const LAZY_TOOL_DEFINITIONS: McpToolDefinition[] = [
  { name: 'tool_search', description: 'Discover available gateway capabilities. Empty query lists tool names and descriptions; search by query or exact name to retrieve original argument schemas before calling tool_call. Results are paginated. This catalog contains only tools authorized for this worker.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, name: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, include_schema: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'tool_call', description: 'Execute a gateway capability discovered with tool_search. Use its exact name and original arguments. All original permissions, validation and cancellation apply. Task reporting and memory retrieval remain directly available.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'], additionalProperties: false } },
];

const fail = (text: string): McpToolResult => ({ content: [{ type: 'text', text }], isError: true });
const result = (value: unknown): McpToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/** Discovery is data-only. Invocation delegates to the SAME dispatcher as direct calls. */
export function createLazyToolCatalog(tools: readonly McpToolDefinition[], excludeReserved = true) {
  const reserved = new Set(LAZY_TOOL_DEFINITIONS.map(tool => tool.name));
  const catalog = [...tools].filter(tool => !excludeReserved || !reserved.has(tool.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(catalog.map(tool => tool.name));
  return {
    search(args: Record<string, unknown>): McpToolResult {
      if ((args.query !== undefined && typeof args.query !== 'string') ||
          (args.name !== undefined && typeof args.name !== 'string') ||
          (args.include_schema !== undefined && typeof args.include_schema !== 'boolean')) return fail('Invalid search arguments');
      const offset = args.offset ?? 0; const limit = args.limit ?? 5;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 ||
          typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) return fail('Invalid search pagination');
      const rawQuery = String(args.query ?? '').trim().toLowerCase();
      const query = rawQuery === '*' ? '' : rawQuery;
      const name = String(args.name ?? '').trim().toLowerCase();
      const text = (tool: McpToolDefinition) => `${tool.name} ${tool.description}`.toLowerCase();
      const words = query ? query.split(/\s+/) : [];
      // Name hits outweigh description hits, and a whole name token outweighs a substring,
      // so "read sheet values" puts read_sheet_values above move_sheet_rows ("spreadsheet").
      const score = (tool: McpToolDefinition) => {
        const toolName = tool.name.toLowerCase(), tokens = toolName.split('_');
        return words.reduce((sum, word) => sum + (tokens.includes(word) ? 4 : toolName.includes(word) ? 2 : 1), 0);
      };
      let matches = name ? catalog.filter(tool => tool.name.toLowerCase() === name) :
        catalog.filter(tool => words.every(word => text(tool).includes(word)))
          .map(tool => ({ tool, score: score(tool) }))
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
          .map(({ tool }) => tool);
      // Natural multi-word queries ("update event") often have no tool containing every
      // word, and an empty result costs the worker a turn: rank by how many words match.
      // The name score stays out of this tier: it would put manage_event above get_events
      // for "update event" but list_calendars above get_events for "list events calendar".
      if (!name && !matches.length) {
        const words = [...new Set(query.split(/[^a-z0-9]+/).filter(Boolean))];
        matches = catalog.map(tool => ({ tool, hits: words.filter(word => text(tool).includes(word)).length }))
          .filter(({ hits }) => hits > 0)
          .sort((a, b) => b.hits - a.hits || a.tool.name.localeCompare(b.tool.name))
          .map(({ tool }) => tool);
      }
      const schemas = args.include_schema ?? Boolean(query || name);
      return result({ total: matches.length, offset, next_offset: offset + limit < matches.length ? offset + limit : null,
        tools: matches.slice(offset, offset + limit).map(tool => schemas ? tool : { name: tool.name, description: tool.description }) });
    },
    async call(args: Record<string, unknown>, dispatch: (name: string, input: Record<string, unknown>) => Promise<McpToolResult>): Promise<McpToolResult> {
      // A model knows these tools by their MCP names (`mcp__gateway__x`); the catalog holds the bare `x`.
      // Models also reach for `tool_name` and JSON-encoded `arguments`; a bare rejection sent one
      // retrying the same wrong shape until its turn ran out, so accept those and name what is wrong.
      const rawName = typeof args.name === 'string' ? args.name : args.tool_name;
      if (typeof rawName !== 'string' || !rawName.trim()) {
        return fail(`tool_call needs "name" (the exact tool name from tool_search) and "arguments" (an object); received keys: ${Object.keys(args).join(', ') || 'none'}`);
      }
      const name = rawName.trim().replace(/^mcp__gateway__/, '');
      if (!names.has(name)) return fail(`Unknown or unauthorized gateway tool "${name}"; call tool_search to list the available tools`);
      let input = args.arguments;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { return fail('Tool arguments must be an object (received a string that is not JSON)'); }
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Tool arguments must be an object');
      return dispatch(name, input as Record<string, unknown>);
    },
  };
}
