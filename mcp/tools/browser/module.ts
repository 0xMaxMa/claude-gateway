import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';

let _reqId = 1;

export class BrowserModule implements ToolModule {
  id = 'browser';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    return process.env.GETPOD_BROWSER_DISABLED !== 'true';
  }

  getTools(): McpToolDefinition[] {
    return browserToolDefs;
  }

  async handleTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const sessionId = process.env.GATEWAY_SESSION_ID;
    const agentId = process.env.GATEWAY_AGENT_ID;
    if (sessionId) args = { ...args, session_id: sessionId };
    if (agentId) args = { ...args, agent_id: agentId };

    const result = await callGetpodBrowser(name, args);

    if (name === 'browser_screenshot' && !result.isError) {
      // getpod-browser returns {type:"image", data: base64, mimeType:"image/jpeg"}.
      // Decode and save to /tmp so callers can attach the file path directly.
      const block = result.content[0] as Record<string, string> | undefined;
      const b64 = block?.['data'] ?? '';
      const mime = block?.['mimeType'] ?? 'image/jpeg';
      if (b64) {
        const ext = mime.includes('png') ? 'png' : 'jpg';
        const sid = (args.session_id as string | undefined) ?? 'default';
        const filePath = path.join('/tmp', `browser_shot_${sid}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
        return { content: [{ type: 'text', text: filePath }] };
      }
    }

    return result;
  }
}

async function readFirstDataLine(res: Response): Promise<string | undefined> {
  if (!res.body) return undefined;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Scan all complete \n-terminated lines; return the first data: line found
      let newlineIdx: number;
      while ((newlineIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        if (line.startsWith('data: ')) return line;
      }
    }
  } finally {
    reader.cancel();
  }
  return buf.startsWith('data: ') ? buf : undefined;
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
  const apiKey = process.env.GETPOD_BROWSER_API_KEY ?? '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body,
    });
  } catch (err) {
    return {
      content: [{ type: 'text', text: `getpod-browser unavailable: ${(err as Error).message}` }],
      isError: true,
    };
  }

  const dataLine = await readFirstDataLine(res);
  if (!dataLine) {
    return {
      content: [{ type: 'text', text: 'empty response from getpod-browser' }],
      isError: true,
    };
  }

  let rpc: {
    result?: { content: Array<Record<string, string>>; isError?: boolean };
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
    description:
      'Create or resume a browser session. Returns stream_url and status. ' +
      'IMPORTANT: After creating a session, always share the stream_url with the user so they can open the browser in their client.',
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
    description: 'Navigate to a URL. If tab_id is provided, navigates that specific tab; otherwise navigates the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        url: { type: 'string' },
        tab_id: {
          type: 'string',
          description: 'Tab ID to navigate (optional, from browser_tabs); omit to use the active tab',
        },
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
      'Capture the current viewport as JPEG. Returns the absolute file path of the saved image (ready to attach to Telegram).',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
    },
  },
  {
    name: 'browser_navigate_tab',
    description: 'Navigate a specific tab (by tab_id) to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        tab_id: { type: 'string', description: 'Tab ID returned by browser_tabs or browser_new_tab' },
        url: { type: 'string' },
        wait: { type: 'string', description: 'Wait condition: load, domcontentloaded, networkidle' },
      },
      required: ['tab_id', 'url'],
    },
  },
];
