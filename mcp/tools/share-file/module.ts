import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import {
  ShareClientError,
  createShares,
  revokeShare,
  shareBridgeEnabled,
  type ShareRef,
} from '../shared/share-client';

/**
 * Standalone share_file MCP tool (#70, plan §15) — explicit create/revoke of
 * short-lived public URLs for a file in the agent's media directory. There is
 * deliberately NO list action (shares are unenumerable, §10). generate_image
 * auto-normalizes refs through the same gateway API, so normal image editing
 * never needs this tool; it exists for explicit workflows (e.g. handing a
 * temporary URL to an external service).
 *
 * #444: was `share_image` back when the bridge could only carry images. The
 * old name stays registered as a thin alias — it is baked into agent
 * workspaces (AGENTS.md, skills, memories) that we do not get to rewrite.
 */
export class ShareFileModule implements ToolModule {
  id = 'share-file';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    return shareBridgeEnabled();
  }

  getTools(): McpToolDefinition[] {
    return shareFileToolDefs;
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name !== 'share_file' && name !== LEGACY_TOOL_NAME) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const legacy = name === LEGACY_TOOL_NAME;
    const action = typeof args.action === 'string' ? args.action : 'create';
    switch (action) {
      case 'create':
        return this.handleCreate(args, legacy);
      case 'revoke':
        return this.handleRevoke(args);
      default:
        return {
          content: [{ type: 'text', text: `share_file: unknown action "${action}" (expected create | revoke)` }],
          isError: true,
        };
    }
  }

  private async handleCreate(args: Record<string, unknown>, legacy: boolean): Promise<McpToolResult> {
    const single = typeof args.path === 'string' && args.path.trim() ? [args.path.trim()] : [];
    const many = Array.isArray(args.paths)
      ? (args.paths.filter((p) => typeof p === 'string' && p.trim()) as string[])
      : [];
    if (single.length && many.length) {
      return { content: [{ type: 'text', text: 'share_file: pass either "path" or "paths", not both.' }], isError: true };
    }
    const paths = single.length ? single : many;
    if (!paths.length) {
      return { content: [{ type: 'text', text: 'share_file: action="create" requires "path" or "paths".' }], isError: true };
    }
    const refs: ShareRef[] = paths.map((p) =>
      p.startsWith('artifact:') ? { artifact_id: p.slice('artifact:'.length) } : { path: p },
    );
    const opts: { purpose?: string; ttlSeconds?: number; allowDocuments: boolean } = {
      // share_file is the agent's explicit "publish this file" verb, so it opts
      // into the full share allowlist (images + PDF). The legacy share_image
      // name does NOT: an instruction written against it meant "share an
      // image", and widening it would retroactively change what an existing
      // call site's live token can serve — a share minted on chart.png would
      // start serving a PDF if the file were later overwritten, where before it
      // failed closed with a 404. The narrow image consumers (line_image,
      // generate_image ref normalization) stay strict for the same reason.
      allowDocuments: !legacy,
    };
    if (typeof args.purpose === 'string' && args.purpose.trim()) opts.purpose = args.purpose.trim();
    if (typeof args.ttl_seconds === 'number' && args.ttl_seconds > 0) opts.ttlSeconds = args.ttl_seconds;
    try {
      const items = await createShares(refs, opts);
      return { content: [{ type: 'text', text: JSON.stringify({ items }, null, 2) }] };
    } catch (err) {
      return this.mapError(err, legacy);
    }
  }

  private async handleRevoke(args: Record<string, unknown>): Promise<McpToolResult> {
    const shareId = typeof args.share_id === 'string' ? args.share_id.trim() : '';
    if (!shareId) {
      return { content: [{ type: 'text', text: 'share_file: action="revoke" requires "share_id".' }], isError: true };
    }
    try {
      await revokeShare(shareId);
      return { content: [{ type: 'text', text: JSON.stringify({ revoked: true, share_id: shareId }) }] };
    } catch (err) {
      return this.mapError(err);
    }
  }

  private mapError(err: unknown, legacy = false): McpToolResult {
    if (err instanceof ShareClientError) {
      // Without this the agent hits a dead end: it asked the image-only name to
      // share a PDF and gets a bare 415 with no hint that a wider tool exists.
      const hint =
        legacy && err.code === 'unsupported_file_type'
          ? ' — share_image is image-only; call share_file for documents.'
          : '';
      return { content: [{ type: 'text', text: `share_file: ${err.code}: ${err.message}${hint}` }], isError: true };
    }
    return {
      content: [{ type: 'text', text: `share_file: gateway unavailable: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

const LEGACY_TOOL_NAME = 'share_image';

const shareFileInputSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'revoke'], description: 'create (default) | revoke' },
    path: { type: 'string', description: 'One media path (e.g. "media/session-1/report.pdf") or "artifact:<id>" to share.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Multiple media paths / artifact refs (max 5).' },
    ttl_seconds: { type: 'number', description: 'Optional lifetime in seconds (default 1800).' },
    purpose: { type: 'string', description: 'Optional purpose tag (default "codex_ref").' },
    share_id: { type: 'string', description: 'Share id to revoke (required for action="revoke").' },
  },
  required: [],
};

// The alias is image-only, so it must not advertise the PDF example: an agent
// reading its schema would be told a document is acceptable and get a 415.
// Same shape, image wording — a separate object costs nothing, since both defs
// are serialized in full either way.
const shareImageInputSchema = {
  ...shareFileInputSchema,
  properties: {
    ...shareFileInputSchema.properties,
    path: { type: 'string', description: 'One media path (e.g. "media/session-1/chart.png") or "artifact:<id>" to share.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Multiple media image paths / artifact refs (max 5).' },
  },
};

const shareFileToolDefs: McpToolDefinition[] = [
  {
    name: 'share_file',
    description:
      'Create or revoke a SHORT-LIVED public URL for a file in this agent\'s media directory (PNG, JPEG, WebP or PDF). ' +
      'action="create" takes "path" (one media path or artifact:<id>) or "paths" (up to 5) and returns ' +
      '{ share_id, url, expires_at } per file — the URL needs no auth and expires automatically (default 30 min). ' +
      'action="revoke" takes "share_id" and invalidates the URL immediately. ' +
      'You normally do NOT need this for image editing: generate_image converts local/artifact references ' +
      'to share URLs automatically. There is no list action.',
    inputSchema: shareFileInputSchema,
  },
  {
    // Deprecated #444 alias, kept so agent instructions written against the old
    // name keep working — and kept IMAGE-ONLY, which is what those instructions
    // meant and what the name still promises. Description is deliberately one
    // line: it must not cost a second copy of the real tool's context budget.
    name: LEGACY_TOOL_NAME,
    description:
      'Deprecated image-only alias for share_file — use share_file instead, which also shares PDFs.',
    inputSchema: shareImageInputSchema,
  },
];
