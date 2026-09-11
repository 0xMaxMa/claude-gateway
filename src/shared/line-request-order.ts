/** LINE clears loading when a reply arrives. Serialize both requests per Agent/chat
 * so a delayed loading request cannot overtake the reply that should clear it. */
const tails = new Map<string, Promise<void>>();
export function orderLineRequest<T>(agentId: string, chatId: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([agentId, chatId]);
  const result = (tails.get(key) ?? Promise.resolve()).then(action);
  const settled = result.then(() => {}, () => {});
  tails.set(key, settled);
  void settled.then(() => { if (tails.get(key) === settled) tails.delete(key); });
  return result;
}
