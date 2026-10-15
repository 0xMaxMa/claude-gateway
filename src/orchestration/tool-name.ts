/** Display the deferred target within its original MCP namespace. Never let a
 * connector claim that its call executed a native or gateway tool. */
export function executionTool(block: { name?: unknown; input?: any }): { name: string; input: Record<string, unknown> } {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
  if (/^mcp__[a-zA-Z0-9_-]+__tool_call$/.test(name) && typeof input.name === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input.name)) {
    // The gateway's tool_call also runs a target named with its own namespace (`mcp__gateway__x`), so
    // that shows as `x`; any other doubled namespace is shown as asked for, never as a tool that ran.
    const namespace = name.slice(0, -'tool_call'.length);
    const target = namespace === 'mcp__gateway__' && input.name.startsWith(namespace) ? input.name : namespace + input.name;
    return {name: target, input: input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments) ? input.arguments : {}};
  }
  return {name, input};
}
