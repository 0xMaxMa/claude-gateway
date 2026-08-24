/**
 * Shared limits for the channel reply tools (Discord / Telegram / Slack).
 *
 * Self-contained on purpose, like share-client.ts: mcp/** ships as source
 * without src/**, so this module must not import from src/ (see
 * tests/unit/mcp-no-src-imports.test.ts).
 */

/**
 * Cap on a single outbound attachment. 50 MB is the smallest of the three
 * platforms' own upload ceilings, so one value keeps the tools' behaviour
 * identical instead of each re-declaring the same literal.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
