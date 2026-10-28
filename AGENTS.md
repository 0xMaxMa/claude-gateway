# Agent and contributor rules

These rules apply to every change in this repository, by people and coding agents alike.

## Never infer meaning from natural-language text with hardcoded patterns

Do not use a regex, keyword list or word list to decide what natural-language text means or intends, in any language. This covers user messages, model replies, transcripts and reviewer output. Examples of what is forbidden:

- Deciding that a reply promises work because it contains "I'll re-run" or "จะเริ่ม".
- Treating a message as a correction because it starts with "no" or "ผิด".
- Treating a name as an editing instruction because it starts with "insert" or "move".

Word lists misread subjects, questions and negation ("จะให้ผมเริ่มแก้เลยไหมครับ" is a question, "no problem" is not a correction), and they miss every phrasing and language they do not list.

Use one of these instead:

1. **A model-declared structured field.** Add an optional field to the response schema or tool input, ask for it in the turn instructions, and read the value. For example, a task-report reply declares `follow_up` in `src/orchestration/response-schema.ts`.
2. **Real system state.** Read task state, tool results, committed commands or stored records.
3. **An explicit command.** Let the user say what they want with a slash command or a UI control.

Structural parsing remains allowed: IDs, URLs, paths, JSON, code fences, markdown, CLI flags, protocol formats and provider error formats, secret redaction, and Unicode script detection for language choice (for example `/[\u0E00-\u0E7F]/`).

`tests/unit/no-semantic-regex.test.ts` enforces this rule. It fails when a regex contains Thai words, when a case-insensitive regex alternates plain English words, or when an array of short strings contains a Thai word. If the guard flags your change, replace the heuristic with one of the options above. Add an `ALLOWED` entry only for a pattern that parses a format rather than meaning, with its reason. The `debt` entries are existing heuristics waiting to be migrated: lower their counts as you remove them, and never raise one.
