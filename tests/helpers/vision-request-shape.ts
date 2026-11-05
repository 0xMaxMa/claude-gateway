/** Structural checks a vision Messages request must pass, for tests whose model is a mock (a mock accepts any shape;
 * the provider answers a malformed one with HTTP 400). Returns one line per problem, empty when the request is valid:
 * - an is_error tool_result carries no image;
 * - each user turn answering tool_use blocks starts with exactly those tool_results, other blocks after them;
 * - roles alternate, starting with the user. */
export function visionRequestProblems(messages: unknown[]): string[] {
  const problems: string[] = [];
  const blocks = (value: unknown): any[] => Array.isArray(value) ? value : [];
  let expected: string[] = [];
  messages.forEach((raw, i) => {
    const message = raw as { role?: unknown; content?: unknown };
    if (message.role !== (i % 2 === 0 ? 'user' : 'assistant')) problems.push(`messages.${i}: role ${String(message.role)} out of turn`);
    const content = blocks(message.content);
    if (message.role === 'assistant') { expected = content.filter(b => b?.type === 'tool_use').map(b => b.id); return; }
    const results = content.findIndex(b => b?.type !== 'tool_result');
    const leading = results < 0 ? content : content.slice(0, results);
    if (content.slice(leading.length).some(b => b?.type === 'tool_result')) problems.push(`messages.${i}: tool_result after another block`);
    const answered = leading.map(b => b.tool_use_id);
    if (JSON.stringify([...answered].sort()) !== JSON.stringify([...expected].sort())) problems.push(`messages.${i}: answers ${JSON.stringify(answered)} for tool_use ${JSON.stringify(expected)}`);
    leading.forEach((b, j) => {
      if (b.is_error === true && blocks(b.content).some(c => c?.type === 'image')) problems.push(`messages.${i}.content.${j}: image inside an is_error tool_result`);
    });
    expected = [];
  });
  return problems;
}
