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
import { searchArchive, findSimilarSharedNotes, getExcerpt, archiveDbPath, sharedDbPathFromEnv, mergeHits } from './archive-reader';
import { sharedNoteExists, readSharedNote, writeSharedNoteAtomic, deleteSharedNote, contentLossPercent, triggerSharedReindex } from './archive-writer';

/** memory_shared_update: below this line-loss %, an update just applies — no confirm needed. */
const UPDATE_LOSS_CONFIRM_THRESHOLD = 50;

/** Corpora the tool can serve. */
const SUPPORTED_CORPORA = new Set(['memory', 'shared', 'all']);

// Mirrors skill_create's MAX_SKILL_SIZE (mcp/tools/skills/handlers.ts) — the
// direct structural precedent for a write-capable, scope-aware MCP tool. A
// shared note lives in a vault SHARED across every agent in the project, so
// leaving it uncapped would let one agent (a runaway loop, or a prompt
// injection) exhaust shared disk / bloat the shared FTS5 index for everyone.
const MAX_SHARED_NOTE_SIZE = 100 * 1024; // 100KB

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
              enum: ['memory', 'shared', 'all'],
              description:
                'Which corpus to search: "memory" (this agent, default), "shared" (the cross-agent shared KB), or "all" (both).',
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
      {
        name: 'memory_shared_create',
        description:
          'Create a NEW note in the shared, cross-agent knowledge base RIGHT NOW, instead of waiting for the nightly automatic promotion. This is an explicit, agent-initiated write (works even when shared-KB mode is "propose"). Notes live in a shared namespace across every agent — pick any "name" you like, there is no agent-id prefix. Fails if a note with this exact name already exists (use memory_shared_update on it instead, after reading it with memory_shared_get). Before writing, this also searches the shared KB for notes with SIMILAR content and, if any are found, returns them instead of creating (to avoid near-duplicate notes cluttering the vault) — pass confirm:true to create anyway once you have checked they are not the same topic; when you do, a `[[link]]` to each similar note found is appended to your content automatically, so the knowledge-graph dashboard stays connected instead of gaining a disconnected duplicate. The note becomes searchable via memory_search (corpus "shared" or "all") shortly after this call returns.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Freeform name identifying this note, e.g. "deploy-runbook". Stable identity — reuse it with memory_shared_update to edit the same note later.' },
            content: { type: 'string', description: 'Full note body to write into the shared KB. Max 100KB.' },
            confirm: { type: 'boolean', description: 'Create anyway even though similar existing notes were found. Default: false.' },
          },
          required: ['name', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'memory_shared_get',
        description: 'Read the full current content of one shared-KB note by its exact "name" (see memory_shared_create). Use this before memory_shared_update so your edit is based on what is actually there — memory_search only returns short snippets, not the full note.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The note\'s exact name.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: 'memory_shared_update',
        description:
          `Update an EXISTING shared-KB note by its exact "name" — replaces its full content with "content". Fails if no note with this name exists yet (use memory_shared_create instead). Read the note first with memory_shared_get and edit it — "content" is what the note becomes, not what gets appended, so anything you drop is gone. As a guard against an update that blindly discards most of the note (rather than an intentional rewrite), if the new content is missing ${UPDATE_LOSS_CONFIRM_THRESHOLD}%+ of the existing note's lines, this returns a warning instead of writing — pass confirm:true once you have checked that is what you intend.`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The note\'s exact name (see memory_shared_create).' },
            content: { type: 'string', description: 'Full replacement body for the note. Max 100KB.' },
            confirm: { type: 'boolean', description: `Apply the update even though it would remove ${UPDATE_LOSS_CONFIRM_THRESHOLD}%+ of the existing content. Default: false.` },
          },
          required: ['name', 'content'],
          additionalProperties: false,
        },
      },
      {
        name: 'memory_shared_delete',
        description: 'Delete one shared-KB note by its exact "name" (see memory_shared_create). Any agent can delete any note in the shared vault — there is no per-agent ownership. This cannot delete notes the nightly dreaming pipeline promoted (different naming scheme).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The note\'s exact name.' },
          },
          required: ['name'],
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

          const personalDb = archiveDbPath(workspaceDir);
          const sharedDb = sharedDbPathFromEnv();
          // Recall counter (planning-66): record retrievals ONLY against the
          // per-agent archive (the GC tier). Gated by the gateway via env, mirroring
          // GATEWAY_SHARED_KB_DIR — off unless dreaming.staleness.recordRetrievals.
          const rec = { recordRetrievals: process.env.GATEWAY_RECORD_RETRIEVALS === '1' };
          let results;
          if (corpus === 'memory') {
            results = searchArchive(personalDb, query, maxResults, rec).map((h) => ({ ...h, corpus: 'memory' }));
          } else if (corpus === 'shared') {
            if (!sharedDb) return this.json({ results: [], unavailable: true, warning: 'shared KB is not enabled.' });
            results = searchArchive(sharedDb, query, maxResults).map((h) => ({ ...h, corpus: 'shared' }));
          } else {
            // "all": merge personal + shared, keep the best by bm25.
            type Tagged = ReturnType<typeof searchArchive>[number] & { corpus: string };
            const mine: Tagged[] = searchArchive(personalDb, query, maxResults, rec).map((h) => ({ ...h, corpus: 'memory' }));
            const shared: Tagged[] = sharedDb
              ? searchArchive(sharedDb, query, maxResults).map((h) => ({ ...h, corpus: 'shared' }))
              : [];
            results = mergeHits(mine, shared, maxResults);
          }

          if (results.length === 0) {
            return this.json({
              results: [],
              note: 'No matches (or the archive has not been indexed yet).',
            });
          }
          return this.json({ results, corpus });
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

        case 'memory_shared_create': {
          // Same gate memory_search uses for corpus:"shared" — fail closed with a
          // clear error rather than silently falling back to some default vault.
          const vaultDir = process.env.GATEWAY_SHARED_KB_DIR;
          if (!vaultDir || !vaultDir.trim()) {
            return this.err('memory_shared_create unavailable: shared KB is not enabled.');
          }
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) return this.err('memory_shared_create requires non-empty "name".');
          let content = typeof args.content === 'string' ? args.content : '';
          if (!content.trim()) return this.err('memory_shared_create requires non-empty "content".');
          if (content.length > MAX_SHARED_NOTE_SIZE) {
            return this.err(`memory_shared_create: content exceeds ${MAX_SHARED_NOTE_SIZE / 1024}KB limit (${(content.length / 1024).toFixed(1)}KB).`);
          }
          if (sharedNoteExists(vaultDir, name)) {
            return this.err(`memory_shared_create: a note named "${name}" already exists. Use memory_shared_update to modify it (read it first with memory_shared_get), or pick a different name.`);
          }

          const confirm = args.confirm === true;
          const sharedDb = sharedDbPathFromEnv();
          const similar = sharedDb ? findSimilarSharedNotes(sharedDb, `${name} ${content}`, 3) : [];
          if (similar.length > 0) {
            if (!confirm) {
              return this.json({
                created: false,
                needsConfirmation: true,
                reason: 'similar-notes-found',
                similar: similar.map((h) => ({ path: h.path, snippet: h.snippet })),
                message: `Found ${similar.length} existing note(s) with similar content — consider memory_shared_update on one of these instead of creating a new one. Pass confirm:true to create "${name}" anyway.`,
              });
            }
            // Confirmed anyway: link to the related notes instead of leaving a
            // disconnected duplicate (#386) — wiki.ts already resolves
            // [[wikilinks]] into real /knowledge/graph edges, no parser change
            // needed, this is the only writer that needs to start emitting them.
            const links = similar
              .map((h) => h.path.replace(/\.md$/i, ''))
              .filter((n) => n !== name)
              .map((n) => `[[${n}]]`);
            if (links.length > 0) {
              content = `${content.trim()}\n\nRelated: ${links.join(' ')}`;
              if (content.length > MAX_SHARED_NOTE_SIZE) {
                return this.err(`memory_shared_create: content plus related-note links exceeds ${MAX_SHARED_NOTE_SIZE / 1024}KB limit.`);
              }
            }
          }

          const notePath = writeSharedNoteAtomic(vaultDir, name, content);
          triggerSharedReindex(vaultDir);
          return this.json({ created: true, path: notePath });
        }

        case 'memory_shared_get': {
          const vaultDir = process.env.GATEWAY_SHARED_KB_DIR;
          if (!vaultDir || !vaultDir.trim()) {
            return this.err('memory_shared_get unavailable: shared KB is not enabled.');
          }
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) return this.err('memory_shared_get requires non-empty "name".');
          const content = readSharedNote(vaultDir, name);
          if (content === null) {
            return this.err(`memory_shared_get: no note named "${name}" found.`);
          }
          return this.json({ name, content });
        }

        case 'memory_shared_update': {
          const vaultDir = process.env.GATEWAY_SHARED_KB_DIR;
          if (!vaultDir || !vaultDir.trim()) {
            return this.err('memory_shared_update unavailable: shared KB is not enabled.');
          }
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) return this.err('memory_shared_update requires non-empty "name".');
          const content = typeof args.content === 'string' ? args.content : '';
          if (!content.trim()) return this.err('memory_shared_update requires non-empty "content".');
          if (content.length > MAX_SHARED_NOTE_SIZE) {
            return this.err(`memory_shared_update: content exceeds ${MAX_SHARED_NOTE_SIZE / 1024}KB limit (${(content.length / 1024).toFixed(1)}KB).`);
          }
          const existing = readSharedNote(vaultDir, name);
          if (existing === null) {
            return this.err(`memory_shared_update: no note named "${name}" found. Use memory_shared_create instead.`);
          }

          const lossPercent = contentLossPercent(existing, content);
          const confirm = args.confirm === true;
          if (lossPercent >= UPDATE_LOSS_CONFIRM_THRESHOLD && !confirm) {
            return this.json({
              updated: false,
              needsConfirmation: true,
              reason: 'large-content-loss',
              lossPercent,
              message: `This update would remove ~${lossPercent}% of the existing note's lines. Pass confirm:true if that's intentional.`,
            });
          }

          const notePath = writeSharedNoteAtomic(vaultDir, name, content);
          triggerSharedReindex(vaultDir);
          return this.json({ updated: true, path: notePath, lossPercent });
        }

        case 'memory_shared_delete': {
          const vaultDir = process.env.GATEWAY_SHARED_KB_DIR;
          if (!vaultDir || !vaultDir.trim()) {
            return this.err('memory_shared_delete unavailable: shared KB is not enabled.');
          }
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) return this.err('memory_shared_delete requires non-empty "name".');
          const deleted = deleteSharedNote(vaultDir, name);
          if (!deleted) {
            return this.err(`memory_shared_delete: no note named "${name}" found.`);
          }
          triggerSharedReindex(vaultDir);
          return this.json({ deleted: true, name });
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
