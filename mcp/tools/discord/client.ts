/**
 * Discord.js client factory.
 * Dynamic import keeps discord.js out of the module graph at load time.
 */

export async function createDiscordClient(token: string): Promise<any> {
  // @ts-ignore — discord.js in mcp/node_modules
  const { Client, GatewayIntentBits, Partials } = await import('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
    ],
  });

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.login(token).catch(reject);
  });

  return client;
}
