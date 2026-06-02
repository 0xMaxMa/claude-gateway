import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';

export class ApiModule implements ToolModule {
  id = 'api';
  toolVisibility: ToolVisibility = 'current-channel';

  isEnabled(): boolean {
    return process.env.GATEWAY_ORIGIN_CHANNEL === 'api';
  }

  getTools(): McpToolDefinition[] {
    return [
      {
        name: 'api_reply',
        description:
          'Attach files to the current API session response. ' +
          'Use to include screenshots or images in the reply returned to the API caller. ' +
          'Files must be absolute paths already saved to the session media directory.',
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute file paths to attach as images.',
            },
          },
          required: ['files'],
        },
      },
    ];
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (name === 'api_reply') {
      return this.handleApiReply(args);
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }

  private async handleApiReply(args: Record<string, unknown>): Promise<McpToolResult> {
    const files = (args.files as string[] | undefined) ?? [];
    if (!files.length) {
      return { content: [{ type: 'text', text: 'No files provided.' }] };
    }

    const apiUrl = process.env.GATEWAY_API_URL;
    const agentId = process.env.GATEWAY_AGENT_ID;
    const sessionId = process.env.GATEWAY_SESSION_ID;
    const apiKey = process.env.GATEWAY_API_KEY;

    if (!apiUrl || !agentId || !sessionId) {
      return {
        content: [{ type: 'text', text: 'api_reply: missing GATEWAY_API_URL, GATEWAY_AGENT_ID, or GATEWAY_SESSION_ID' }],
        isError: true,
      };
    }

    try {
      const res = await fetch(
        `${apiUrl}/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/attachments`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
          },
          body: JSON.stringify({ files }),
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          content: [{ type: 'text', text: `api_reply: gateway returned ${res.status}: ${text}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: `Attached ${files.length} file(s).` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `api_reply: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
}
