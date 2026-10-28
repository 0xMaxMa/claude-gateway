/** Who a voice call speaks for, and which conversation its turns join.
 * API calls keep their own `api` conversation; a Telegram call joins the DM. */
export type VoiceScope =
  | { kind: 'api'; principalId: string; chatId: string }
  | { kind: 'telegram'; principalId: `telegram:${string}`; chatId: string; threadKey: string };
