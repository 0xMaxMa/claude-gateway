import { createHash } from 'crypto';
/** Hash protocol tool input + result; ignore incidental tool IDs. No site/tool-specific rules. */
export function observeToolRepetition(report: (signature: string, id: string) => void, boundary?: (active: string[]) => void): (line: string) => void {
  const calls = new Map<string, { name: string; inputHash: string }>();
  return line => {
    try {
      const event = JSON.parse(line);
      for (const block of event.message?.content ?? []) {
        if (event.type === 'assistant' && block.type === 'tool_use') {
          calls.set(block.id, {name: block.name, inputHash: createHash('sha256').update(JSON.stringify(block.input ?? null)).digest('hex')});
          boundary?.([...calls.values()].map(call => call.name));
          if (calls.size > 128) calls.delete(calls.keys().next().value!);
        }
        if (event.type === 'user' && block.type === 'tool_result') {
          const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
          boundary?.([...calls.values()].map(call => call.name));
          if (call && !call.name.endsWith('task_report_progress')) report(createHash('sha256').update(JSON.stringify([call,block.content,block.is_error])).digest('hex'),block.tool_use_id);
        }
      }
    } catch { /* Observation never interferes with work. */ }
  };
}
