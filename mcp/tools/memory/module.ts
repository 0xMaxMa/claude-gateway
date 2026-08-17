/**
 * Memory tool module (planning-64 K1) — implements ToolModule.
 *
 * Read-only, on-demand retrieval over the per-agent knowledge archive
 * (`kb.sqlite`, built by src/ under Node). Two lanes of memory: the small core
 * (MEMORY.md/USER.md) is injected every turn; everything else lives in the
 * searchable archive and is reached here via `memory_search` / `memory_get` —
 * so the bulk never has to sit in the prompt. Runs under Bun; reads via
 * `bun:sqlite` (see archive-reader.ts).
 */

import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import { searchArchive, getExcerpt, archiveDbPath } from './archive-reader';

/** Corpora this phase can serve. `shared`/`all` arrive with K3 — fail closed. */
const SUPPORTED_CORPORA = new Set(['memory']);

export class MemoryModule implements ToolModule {
  id = 'memory';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    // Available whenever the agent's workspace dir is known (same gate as skills).
    return Boolean(process.env.GATEWAY_WORKSPACE_DIR);
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'memory_search',
        description:
          'Search your long-term memory archive (past notes under memory/, plus MEMORY.md/USER.md) by keyword and get the most relevant snippets with their file + line range. Use this to recall details that are NOT in the memory currently loaded into your context — the archive holds far more than fits in the prompt. Read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords to search for.' },
            maxResults: {
              type: 'number',
              description: 'Max snippets to return (default 6, max 20).',
            },
            corpus: {
              type: 'string',
              enum: ['memory'],
              description: 'Which corpus to search. Only "memory" (this agent) is available. Default "memory".',
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'memory_get',
        description:
          'Read an exact line range from one of your memory files (a path returned by memory_search, e.g. "memory/foo.md", or "MEMORY.md"/"USER.md"). Use after memory_search to pull the full context around a snippet. Read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Memory-scoped path (memory/*.md, MEMORY.md, USER.md).' },
            from: { type: 'number', description: '1-indexed start line (default 1).' },
            lines: { type: 'number', description: 'Number of lines to return (default 200).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const workspaceDir = process.env.GATEWAY_WORKSPACE_DIR;
    if (!workspaceDir) {
      return this.err('Memory archive unavailable: no workspace directory configured.');
    }

    try {
      switch (name) {
        case 'memory_search': {
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (!query) return this.err('memory_search requires a non-empty "query".');

          // Fail closed on an unsupported corpus rather than silently widening scope.
          const corpus = typeof args.corpus === 'string' ? args.corpus : 'memory';
          if (!SUPPORTED_CORPORA.has(corpus)) {
            return this.json({
              results: [],
              unavailable: true,
              warning: `corpus "${corpus}" is not available yet (shared/all arrive in a later phase). Use "memory".`,
            });
          }

          const rawMax = Number.isFinite(args.maxResults as number) ? (args.maxResults as number) : 6;
          const maxResults = Math.max(1, Math.min(20, Math.floor(rawMax)));

          const results = searchArchive(archiveDbPath(workspaceDir), query, maxResults);
          if (results.length === 0) {
            return this.json({
              results: [],
              note: 'No matches (or the archive has not been indexed yet).',
            });
          }
          return this.json({ results, corpus: 'memory' });
        }

        case 'memory_get': {
          const p = typeof args.path === 'string' ? args.path : '';
          const from = Number.isFinite(args.from as number) ? (args.from as number) : 1;
          const lines = Number.isFinite(args.lines as number) ? (args.lines as number) : 200;
          const excerpt = getExcerpt(workspaceDir, p, from, lines);
          if (!excerpt) {
            return this.err(`memory_get: "${p}" is not a readable memory-scoped file (memory/*.md, MEMORY.md, USER.md).`);
          }
          return this.json(excerpt);
        }

        default:
          return this.err(`Unknown memory tool: ${name}`);
      }
    } catch (e) {
      return this.err(`memory tool error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private json(obj: unknown): McpToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
  }

  private err(text: string): McpToolResult {
    return { content: [{ type: 'text', text }], isError: true };
  }
}
