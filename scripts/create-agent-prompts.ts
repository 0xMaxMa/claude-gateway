/**
 * Prompt templates and output parsers for the create-agent wizard.
 */

/**
 * Build the Claude generation prompt for workspace markdown files.
 */
export function buildGenerationPrompt(
  name: string,
  description: string,
  options?: { signatureEmoji?: string }
): string {
  const signatureNote = options?.signatureEmoji
    ? `\nThe agent has a signature emoji: ${options.signatureEmoji}. Include it in the Emoji Usage section as the signature emoji.`
    : '';

  return `You are helping configure a Claude Code agent for the claude-gateway multi-bot system.

The user described the agent as:
"""
${description}
"""

Generate workspace markdown files for this agent. Output each file as:

=== agent.md ===
<content here>

=== soul.md ===
<content here>

Rules:
- agent.md is REQUIRED. Start with "# Agent: ${name}" on line 1.
  Include: role, rules, what it can/cannot do, language to use.
  Always include these rules under ## Rules:
  "Report completion (mandatory): After finishing any task, ALWAYS send a reply summarising what
   was done before the session ends. Never silently complete work without reporting the result back
   to the user."
  Also include an "## Emoji Usage" section in agent.md with these guidelines:
    - React to messages naturally — use the react tool. Max 1 reaction per message.
    - Signature emoji: ${options?.signatureEmoji ? `Use ${options.signatureEmoji} as your signature emoji in greetings or sign-offs.` : 'None assigned.'}${signatureNote}
- soul.md: tone and personality only (not rules). Omit if no distinct style.
- user.md: target user profile. Omit if public/unknown.
- tools.md: available tools or capabilities. Omit if none specified.
- heartbeat.md: only if proactive/scheduled tasks were described. Use YAML tasks format.
- bootstrap.md: only if a special first-run greeting is appropriate.
- Keep each file under 500 words.
- Omit files that are not relevant.
- IMPORTANT: On the very FIRST line of your output (before any === markers), output a single emoji that best represents this agent's personality or role. Just the emoji alone on line 1, nothing else.`;
}

/**
 * Parse Claude's generated output into a Map of filename -> content.
 * Expects sections in the format:
 *   === filename.md ===
 *   <content here>
 */
export function parseGeneratedFiles(output: string): Map<string, string> {
  const files = new Map<string, string>();
  // Match sections starting with === filename ===
  const sectionRegex = /^=== ([^\s=][^=]*?) ===\s*$/gm;

  const matches: Array<{ filename: string; headerStart: number; contentStart: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(output)) !== null) {
    const headerStart = match.index;
    const afterHeader = match.index + match[0].length;
    // Skip the newline immediately after the header line
    const contentStart = output[afterHeader] === '\n' ? afterHeader + 1 : afterHeader;
    matches.push({ filename: match[1].trim(), headerStart, contentStart });
  }

  for (let i = 0; i < matches.length; i++) {
    const { filename, contentStart } = matches[i];
    // Content ends at the start of the next section header (not mid-header)
    const contentEnd = i + 1 < matches.length ? matches[i + 1].headerStart : output.length;
    const content = output.slice(contentStart, contentEnd).trimEnd();

    if (content.length > 0) {
      files.set(filename, content);
    }
  }

  return files;
}

/**
 * Build the Claude update prompt for an existing agent.md file.
 */
export function buildUpdatePrompt(name: string, currentContent: string): string {
  return `You are updating the agent.md file for a Claude Gateway agent named "${name}".

Current agent.md content:
"""
${currentContent}
"""

Update this agent.md to follow current best practices:
- Preserve the agent's role, purpose, and all existing rules
- REMOVE any "Acknowledge first" rule if present — this is now handled at infrastructure level
- Ensure ## Rules section includes this rule (add if missing, strengthen if weak):
  "Report completion (mandatory): After finishing any task, ALWAYS send a reply summarising what
   was done before the session ends. Never silently complete work without reporting the result back
   to the user."
- Ensure an "## Emoji Usage" section exists with these guidelines:
    - React to messages naturally — use the react tool. Max 1 reaction per message.
    - Signature emoji: preserve any existing signature emoji setting.
- Remove any mention of "emojiReactionMode" if present
- Keep the file under 500 words

Output ONLY the updated agent.md content — no preamble, no explanation, no commentary.
Start directly with the first line of the agent.md content.`;
}
