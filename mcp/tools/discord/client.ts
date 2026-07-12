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
    // 'clientReady' is the renamed 'ready' event (discord.js v14 emits both;
    // 'ready' is deprecated and becomes clientReady-only in v15).
    client.once('clientReady', () => {
      process.stderr.write(`[CLIENT-READY] logged in as ${client.user?.tag ?? '?'}\n`);
      resolve();
    });
    client.once('error', reject);
    // TEMP DEBUG — remove once the connect-hang investigation is done.
    client.on('debug', (m: string) => process.stderr.write(`[dbg] ${m}\n`));
    client.on('warn', (m: string) => process.stderr.write(`[warn] ${m}\n`));
    client.on('shardError', (e: Error) => process.stderr.write(`[shardError] ${e?.stack ?? e}\n`));
    client.on('shardDisconnect', (e: unknown, id: number) => process.stderr.write(`[shardDisconnect] shard=${id} ${JSON.stringify(e)}\n`));
    client.on('shardReconnecting', (id: number) => process.stderr.write(`[shardReconnecting] shard=${id}\n`));
    client.on('invalidated', () => process.stderr.write('[invalidated]\n'));
    client.login(token).catch(reject);
  });

  return client;
}
