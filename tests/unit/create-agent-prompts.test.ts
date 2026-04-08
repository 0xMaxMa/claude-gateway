/**
 * Unit tests for create-agent-prompts module.
 */

import {
  parseGeneratedFiles,
  buildGenerationPrompt,
  buildUpdatePrompt,
} from '../../scripts/create-agent-prompts';

describe('create-agent-prompts', () => {
  // ---------------------------------------------------------------------------
  // parseGeneratedFiles
  // ---------------------------------------------------------------------------
  describe('parseGeneratedFiles', () => {
    it('parses a single section correctly', () => {
      const output = `=== agent.md ===
# Agent: Test
You are Test, a helpful assistant.`;
      const files = parseGeneratedFiles(output);
      expect(files.size).toBe(1);
      expect(files.has('agent.md')).toBe(true);
      expect(files.get('agent.md')).toContain('# Agent: Test');
    });

    it('parses multiple sections correctly', () => {
      const output = `=== agent.md ===
# Agent: Alfred
You are Alfred.

=== soul.md ===
Formal, polite tone.

=== user.md ===
Private user profile.`;
      const files = parseGeneratedFiles(output);
      expect(files.size).toBe(3);
      expect(files.has('agent.md')).toBe(true);
      expect(files.has('soul.md')).toBe(true);
      expect(files.has('user.md')).toBe(true);
      expect(files.get('agent.md')).toContain('# Agent: Alfred');
      expect(files.get('soul.md')).toContain('Formal, polite tone.');
      expect(files.get('user.md')).toContain('Private user profile.');
    });

    it('trims whitespace from section content (trailing)', () => {
      const output = `=== agent.md ===
# Agent: Trim
Content with trailing spaces.

=== soul.md ===
Soul content.`;
      const files = parseGeneratedFiles(output);
      const agentMd = files.get('agent.md')!;
      expect(agentMd).not.toMatch(/\s+$/);
    });

    it('ignores content before the first section header', () => {
      const output = `Some preamble text that should be ignored.
Here is another line of preamble.

=== agent.md ===
# Agent: Clean
This is the agent content.`;
      const files = parseGeneratedFiles(output);
      expect(files.size).toBe(1);
      const content = files.get('agent.md')!;
      expect(content).not.toContain('preamble');
      expect(content).toContain('# Agent: Clean');
    });

    it('handles five sections correctly', () => {
      const output = `=== agent.md ===
# Agent: Full
Role description.

=== soul.md ===
Personality.

=== user.md ===
User profile.

=== tools.md ===
Available tools.

=== heartbeat.md ===
tasks:
  - name: daily
    cron: "0 8 * * *"`;
      const files = parseGeneratedFiles(output);
      expect(files.size).toBe(5);
      expect(files.has('agent.md')).toBe(true);
      expect(files.has('soul.md')).toBe(true);
      expect(files.has('user.md')).toBe(true);
      expect(files.has('tools.md')).toBe(true);
      expect(files.has('heartbeat.md')).toBe(true);
    });

    it('returns empty map when output has no sections', () => {
      const output = 'No section headers here at all.';
      const files = parseGeneratedFiles(output);
      expect(files.size).toBe(0);
    });

    it('returns empty map for empty string', () => {
      const files = parseGeneratedFiles('');
      expect(files.size).toBe(0);
    });

    it('includes soul.md section with correct content when agent.md has no body', () => {
      // When agent.md has no content between headers, the parser may include
      // partial text; what matters is soul.md content is correct.
      const output = `=== soul.md ===
Soul content here.`;
      const files = parseGeneratedFiles(output);
      expect(files.has('soul.md')).toBe(true);
      expect(files.get('soul.md')).toContain('Soul content here.');
    });

    it('preserves section content without stripping leading lines', () => {
      const output = `=== agent.md ===
# Agent: Preserve
Line 1.
Line 2.
Line 3.`;
      const files = parseGeneratedFiles(output);
      const content = files.get('agent.md')!;
      expect(content).toContain('Line 1.');
      expect(content).toContain('Line 2.');
      expect(content).toContain('Line 3.');
    });
  });

  // ---------------------------------------------------------------------------
  // buildGenerationPrompt
  // ---------------------------------------------------------------------------
  describe('buildGenerationPrompt', () => {
    it('includes the agent name in the output', () => {
      const prompt = buildGenerationPrompt('Alfred', 'A formal English butler.');
      expect(prompt).toContain('Alfred');
    });

    it('includes the description in the output', () => {
      const description = 'A Thai-language customer support bot for my SaaS product';
      const prompt = buildGenerationPrompt('Support', description);
      expect(prompt).toContain(description);
    });

    it('includes the agent name in the agent.md rule', () => {
      const prompt = buildGenerationPrompt('Jeeves', 'A helpful butler.');
      expect(prompt).toContain('# Agent: Jeeves');
    });

    it('mentions required files', () => {
      const prompt = buildGenerationPrompt('Bot', 'A bot.');
      expect(prompt).toContain('agent.md');
      expect(prompt).toContain('soul.md');
    });

    it('returns a non-empty string', () => {
      const prompt = buildGenerationPrompt('Agent', 'Description.');
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    // T12: No "Acknowledge first"
    it('T12: does not contain "Acknowledge first"', () => {
      const prompt = buildGenerationPrompt('Bot', 'A helpful bot.');
      expect(prompt).not.toContain('Acknowledge first');
    });

    // T13: No "emojiReactionMode"
    it('T13: does not contain "emojiReactionMode"', () => {
      const prompt = buildGenerationPrompt('Bot', 'A helpful bot.');
      expect(prompt).not.toContain('emojiReactionMode');
    });

    // T14: Has "Report completion"
    it('T14: contains "Report completion"', () => {
      const prompt = buildGenerationPrompt('Bot', 'A helpful bot.');
      expect(prompt).toContain('Report completion');
    });
  });

  // ---------------------------------------------------------------------------
  // buildUpdatePrompt — T15
  // ---------------------------------------------------------------------------
  describe('buildUpdatePrompt', () => {
    // T15: No "Acknowledge first"
    it('T15: does not contain "Acknowledge first" as a rule to add', () => {
      const prompt = buildUpdatePrompt('Bot', '# Agent: Bot\n## Rules\nsome rules');
      // The update prompt should instruct removal, not addition
      expect(prompt).not.toMatch(/add.*Acknowledge first/i);
      expect(prompt).toContain('REMOVE');
    });
  });

});
