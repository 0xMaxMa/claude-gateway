/** Public tool activity excludes reasoning and bounds input previews. */
export interface ToolActivity { type: 'tool_use' | 'tool_result'; id: string; name: string; input?: Record<string, unknown>; is_error?: boolean; }
export function toolActivity(publish: (event: ToolActivity) => void): (line: string) => void {
  const calls = new Map<string, string>();
  const finished = new Set<string>();
  return line => {
    let event: any; try { event = JSON.parse(line); } catch { return; }
    if (!Array.isArray(event.message?.content)) return;
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && !calls.has(block.id) && calls.size < 2000) {
        calls.set(block.id, block.name);
        const input: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(block.input ?? {}).slice(0, 16)) {
          if (/token|secret|password|authorization|api.?key/i.test(key)) continue;
          if (typeof value === 'string') input[key] = value.slice(0, 2000);
          else if (typeof value === 'number' || typeof value === 'boolean') input[key] = value;
        }
        publish({ type: 'tool_use', id: block.id, name: block.name, input });
      }
      if (block.type === 'tool_result' && calls.has(block.tool_use_id) && !finished.has(block.tool_use_id)) {
        finished.add(block.tool_use_id);
        publish({ type: 'tool_result', id: block.tool_use_id, name: calls.get(block.tool_use_id)!, is_error: Boolean(block.is_error) });
      }
    }
  };
}
