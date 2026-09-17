/** Display the underlying gateway tool for deferred calls without trusting
 * arbitrary connector/native tool names as a gateway wrapper. */
export function executionTool(block: { name?: unknown; input?: any }): { name: string; input: Record<string, unknown> } {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
  if (name === 'mcp__gateway__tool_call' && typeof input.name === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(input.name)) {
    return {name: `mcp__gateway__${input.name}`, input: input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) ? input.arguments : {}};
  }
  return {name, input};
}
