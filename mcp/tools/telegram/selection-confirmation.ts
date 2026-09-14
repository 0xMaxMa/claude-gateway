/** Keep a durable confirmation in chat, matching the /models menu behavior. */
export async function confirmSelection(ctx: {
  editMessageText(text: string, options: {reply_markup: {inline_keyboard: never[]}}): Promise<unknown>;
  reply(text: string): Promise<unknown>;
  deleteMessage(): Promise<unknown>;
}, text: string): Promise<void> {
  try { await ctx.editMessageText(text, {reply_markup: {inline_keyboard: []}}); }
  catch (error) {
    if (/message is not modified/i.test(String((error as any)?.description ?? (error as any)?.message))) return;
    // If Telegram cannot edit an old menu, retain the confirmation as a new
    // message before removing the old controls. Never lose both.
    await ctx.reply(text);
    await ctx.deleteMessage().catch(() => {});
  }
}
export function voiceModeConfirmation(mode: string): string {
  const labels: Record<string,string> = {on:'Always',auto:'Only reply voice message',off:'Off'};
  if (!(mode in labels)) throw Error('INVALID_VOICE_MODE');
  return `✅ Voice replies: ${labels[mode]}`;
}
