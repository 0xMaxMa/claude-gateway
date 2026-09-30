import { JEV_TOOL } from '../../../dist/orchestration/jev-tool.js';
// MCP sources are published, src/ is not. Share the compiled schema so an
// installed package has the same inventory as a development checkout.
import { WORKFLOW_SCHEMA } from '../../../dist/orchestration/workflow.js';
import type { McpToolDefinition, McpToolResult } from '../../types';

const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
export { AGENT_TASK_TOOLS } from '../../../dist/orchestration/agent-tool-schemas.js';
export const WORKER_REPORT_TOOLS: McpToolDefinition[] = [
  JEV_TOOL,
  { name: 'task_memory_append', description: 'Append an explicitly requested memory note for a channel task. API tasks cannot write memory. Files are restricted to MEMORY.md, USER.md, or memory/<name>.md. Retains existing content and deduplicates retries.', inputSchema: schema({ note: text, path: text }, ['note']) },
  { name: 'task_stage_file', description: 'Stage a finished image or document for the user. The orchestration attaches it to the next completed agent response after this task succeeds, using the original destination. This tool does not send to a channel. Call once per output file. For an image returned by an MCP tool (such as a remote browser screenshot), omit path to use the latest captured image in this attempt, or pass source_tool_call_id to select its tool call. The gateway saves the actual image bytes; never invent a screenshot filename. For an existing local file supply path.', inputSchema: schema({ path: text, source_tool_call_id: text, caption: text }, []) },
  { name: 'task_report_progress', description: 'Report factual progress internally. At phase changes include a checkpoint with phase, evidenceVersion, checks, findings and nextAction. This does not send a user message.', inputSchema: schema({ text, checkpoint: WORKFLOW_SCHEMA }, ['text']) },
  { name: 'task_request_input', description: 'Ask the user for information required by your task, then end this turn immediately.', inputSchema: schema({ question: text }, ['question']) },
];

export async function callTaskBridge(tool: string, args: Record<string, unknown>, requestId: string, signal: AbortSignal): Promise<McpToolResult> {
  // Rotated by the gateway at each decision/attempt boundary. A loaded token is
  // immutable for this request; late requests cannot borrow the next decision.
  const { readFile } = await import('node:fs/promises');
  const scope = JSON.parse(await readFile(process.env.GATEWAY_ORCHESTRATION_TICKET_FILE!, 'utf8')) as { url: string; token: string };
  const response = await fetch(scope.url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scope.token}` },
    body: JSON.stringify({ tool, args, action_id: requestId }) });
  const body = await response.text();
  if(response.ok && tool==='task_status') {
    const value=JSON.parse(body),image=value.screenshot;
    if(image?.type==='image' && ['image/png','image/jpeg'].includes(image.mimeType) && typeof image.data==='string') {
      delete value.screenshot;
      return {content:[{type:'text',text:JSON.stringify(value)},image]};
    }
  }
  return { content: [{ type: 'text', text: body }], ...(response.ok ? {} : { isError: true }) };
}
