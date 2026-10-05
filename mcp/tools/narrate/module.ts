import type { ToolModule, McpToolDefinition, McpToolResult, ToolVisibility } from '../../types';
import { callTaskBridge } from '../tasks/module';

/**
 * Long-form narration (worker only). TTS credentials live in the gateway, so this
 * module just forwards to the task bridge; the gateway splits the text, synthesizes
 * it piece by piece and stages the resulting audio files for the agent's reply.
 */
export const NARRATE_TOOL: McpToolDefinition = {
  name: 'narrate',
  description:
    'Read text aloud to the user as a sequence of audio messages. Use this when the user asks to HEAR a page, post, document or file — ' +
    'pass the full text (or a file path inside this task) and every character is spoken, in order. ' +
    'Pass exactly one of `text` or `path`. Do NOT summarize or shorten the text you pass unless the user asked for a summary; ' +
    'the tool never rewrites it. This tool cannot fetch URLs: fetch the page yourself and pass its text. ' +
    'The audio files are staged automatically (do not call task_stage_file for them). ' +
    'Afterwards finish the task with ONE short sentence saying how many parts were prepared (your final reply must be non-empty so the audio attaches); ' +
    'do not repeat the content. If the result has `ok:false`, report `stopped_reason` and how many parts were staged. ' +
    'Host workers only: container workers cannot use media tools.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The exact text to read aloud.' },
      path: { type: 'string', description: 'Absolute path of a UTF-8 text file inside this task scope or an attachment.' },
    },
    additionalProperties: false,
  },
};

export class NarrateModule implements ToolModule {
  id = 'narrate';
  toolVisibility: ToolVisibility = 'all-configured';

  isEnabled(): boolean {
    return process.env.GATEWAY_ORCHESTRATION_ROLE === 'worker' && process.env.GATEWAY_ORCHESTRATION_MEDIA === 'true' && Boolean(process.env.GATEWAY_ORCHESTRATION_TICKET_FILE);
  }
  getTools(): McpToolDefinition[] { return [NARRATE_TOOL]; }
  handleTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (name !== 'narrate') return Promise.resolve({ content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true });
    return callTaskBridge(name, args, crypto.randomUUID(), signal ?? new AbortController().signal);
  }
}
