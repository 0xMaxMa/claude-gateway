import { GENERATED_NOUNS } from './commands.generated';

/**
 * Core (hand-written) top-level commands, distinct from the generated resource
 * nouns. Kept here (a cheap, dependency-free module) so the boot entry point can
 * decide whether argv[2] is a CLI command WITHOUT importing the full CLI runner.
 */
export const CORE_COMMANDS = [
  'help',
  'version',
  'api',
  'gateway',
  'doctor',
  'debug-bundle',
  'logs',
] as const;

/** True if `name` is a friendly CLI command (a core command or a resource noun),
 *  so the binary should dispatch to the CLI instead of booting the server. */
export function isCliCommand(name: string | undefined): boolean {
  if (!name) return false;
  if (name.startsWith('-')) return false;
  return (CORE_COMMANDS as readonly string[]).includes(name) || GENERATED_NOUNS.includes(name);
}
