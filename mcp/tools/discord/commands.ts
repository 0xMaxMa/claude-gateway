/**
 * Discord slash command definitions — openclaw pattern from native-command.ts.
 * SLASH_COMMANDS is plain JSON; discord.js builders only used in registerCommands().
 */

import type { SlashCommandDef } from './types';

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'ask',
    description: 'Ask the agent a question',
    options: [{ name: 'question', description: 'Your question', required: true, type: 'STRING' }],
  },
  { name: 'session', description: 'Show current session info' },
  {
    name: 'new',
    description: 'Start a new conversation',
    options: [{ name: 'name', description: 'Session name', required: false, type: 'STRING' }],
  },
  {
    name: 'model',
    description: 'Show or switch AI model',
    options: [{ name: 'name', description: 'Model name', required: false, type: 'STRING' }],
  },
];

export async function registerCommands(
  client: any,
  token: string,
): Promise<void> {
  // @ts-ignore — discord.js in mcp/node_modules
  const { REST, Routes, SlashCommandBuilder } = await import('discord.js');
  const rest = new REST().setToken(token);

  const bodies = SLASH_COMMANDS.map(cmd => {
    const builder = new SlashCommandBuilder()
      .setName(cmd.name)
      .setDescription(cmd.description);
    for (const opt of cmd.options ?? []) {
      builder.addStringOption((o: any) =>
        o.setName(opt.name).setDescription(opt.description).setRequired(opt.required),
      );
    }
    return builder.toJSON();
  });

  await rest.put(Routes.applicationCommands(client.user!.id), { body: bodies });
}
