/** Default UTF-8 byte budget for the catalog in the agent's appended system prompt
 * (orchestration.conversation.skillCatalogBytes). It is resent on every decision
 * turn, and hundreds of installed plugin skills would otherwise grow it without bound.
 * A dependency-free leaf, so config.ts and skills.ts share it without an import cycle. */
export const SKILL_CATALOG_BUDGET_BYTES = 64 * 1024;
