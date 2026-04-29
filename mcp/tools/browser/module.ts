import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';

let _reqId = 1;

export class BrowserModule implements ToolModule {
  id = 'browser';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    return process.env.GETPOD_BROWSER_DISABLED !== '1';
  }

  getTools(): McpToolDefinition[] {
    return browserToolDefs;
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const agentId = process.env.GATEWAY_AGENT_ID;
    if (agentId) args = { ...args, session_id: agentId };
    return callGetpodBrowser(name, args);
  }
}

async function callGetpodBrowser(
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const id = _reqId++;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  const baseUrl = process.env.GETPOD_BROWSER_URL ?? 'http://127.0.0.1:10880';
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    return {
      content: [{ type: 'text', text: `getpod-browser unavailable: ${(err as Error).message}` }],
      isError: true,
    };
  }

  const text = await res.text();
  const dataLine = text.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) {
    return {
      content: [{ type: 'text', text: 'empty response from getpod-browser' }],
      isError: true,
    };
  }

  let rpc: {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { message: string };
  };
  try {
    rpc = JSON.parse(dataLine.slice('data: '.length));
  } catch {
    return {
      content: [{ type: 'text', text: 'invalid JSON from getpod-browser' }],
      isError: true,
    };
  }

  if (rpc.error) {
    return { content: [{ type: 'text', text: rpc.error.message }], isError: true };
  }
  if (!rpc.result) {
    return { content: [{ type: 'text', text: 'no result in response' }], isError: true };
  }

  return {
    content: rpc.result.content as Array<{ type: 'text'; text: string }>,
    isError: rpc.result.isError,
  };
}

const browserToolDefs: McpToolDefinition[] = [
  {
    name: 'browser_create_session',
    description: 'Create or resume a browser session. Returns stream_url and status.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Unique session identifier' },
        idle_timeout_seconds: {
          type: 'integer',
          description: 'Idle timeout in seconds (0 = no timeout)',
        },
      },
    },
  },
  {
    name: 'browser_close_session',
    description: 'Close a browser session, killing the process and removing session data.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
    },
  },
  {
    name: 'browser_get_stream_url',
    description: 'Get the WebSocket stream URL for an active session (for frontend live view).',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: { type: 'string' },
        wait: {
          type: 'string',
          description: 'Wait condition: load, domcontentloaded, networkidle',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Return the accessibility tree of the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        interactive_only: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by accessibility ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, ref: { type: 'string' } },
      required: ['ref'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill an input element with a value.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        ref: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the currently focused element.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate JavaScript in the browser and return the result.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, script: { type: 'string' } },
      required: ['script'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page at (x, y) by (deltaX, deltaY).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        deltaX: { type: 'integer' },
        deltaY: { type: 'integer' },
      },
      required: ['x', 'y', 'deltaX', 'deltaY'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for a condition: element selector, networkidle, or URL pattern.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, condition: { type: 'string' } },
      required: ['condition'],
    },
  },
  {
    name: 'browser_get_text',
    description: 'Get text content of an element matching the selector.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'browser_new_tab',
    description: 'Open a new browser tab, optionally navigating to a URL. Returns tab_id.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, url: { type: 'string' } },
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a browser tab by tab_id.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List all open browser tabs.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the current viewport as JPEG. Returns {data: base64, mimeType: image/jpeg}.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
    },
  },
];
