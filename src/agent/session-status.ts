import { commandCatalog } from './command-help';
import type { CommandChannel } from './builtin-commands';
/** Shared /session presentation; context is measured by the runner/dashboard source.
 * `model` is the configured next-turn model; when the measured context came from a
 * different model it is labelled separately so a name never fronts another model's window. */
export function formatSessionStatus(sessionId: string, name: string, model: string,
  context: { text: string; contextUsedPct: number | null; contextModel?: string | null }, html = false, channel: CommandChannel = 'telegram'): string {
  const escape = (value: string) => html ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : value;
  return [
    `📌 Current Session: ${escape(name)}`,
    html ? `<code>${escape(sessionId)}</code>` : sessionId,
    '', `👉 Context: ${context.text}`, `🤖 Model: ${escape(model)}`,
    ...(context.contextModel && context.contextModel !== model ? [`📏 Context measured on: ${escape(context.contextModel)}`] : []),
    ...(context.contextUsedPct != null && context.contextUsedPct >= 80 ? ['', '💡 Near limit — consider /compact'] : []),
    '', `Commands: ${commandCatalog(channel).filter(command => ['/sessions', '/new', '/rename', '/clear', '/compact', '/help'].includes(command.name)).map(command => command.name).join(' ')}`,
  ].join('\n');
}
