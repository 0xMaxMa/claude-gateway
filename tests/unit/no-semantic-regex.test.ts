import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import * as ts from 'typescript';

// Repository rule (AGENTS.md, issue #629): never infer the meaning or intent of natural-language
// text with hardcoded regex, keyword or word lists, in any language. Word lists misread subjects,
// questions and negation, and they silently miss every phrasing and language they do not list.
// Use a model-declared structured field, real system state, or an explicit command instead.
//
// This guard parses every source file and flags the shapes such heuristics take:
//   thai-regex     a regex with Thai letters outside a character class (Thai words to match)
//   english-words  a case-insensitive regex with an alternation of three or more plain words
//   thai-words     an array of short strings that includes a Thai word (a word list)
// Script detection (a Thai character class such as [\u0E00-\u0E7F]) is not a word and is allowed.

type Kind = 'thai-regex' | 'english-words' | 'thai-words';
interface Finding { file: string; line: number; kind: Kind; source: string }

const THAI_LETTER = /[\u0E01-\u0E5B]/;
const PLAIN_WORD = /^[a-z]{2,}(?:'[a-z]+)?(?:(?:\\s[+*]?| )[a-z]+)*$/;

/** The regex source with escapes neutralised and character classes removed: what remains are
 * the literal sequences the pattern matches. */
function literalPart(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next === 'u' || next === 'x' || next === 'p' || next === 'P') {
        // \uXXXX, \u{...}, \xXX, \p{...}: a code point or a property, never a word.
        const braced = /^.[upP]?\{[^}]*\}/.exec(source.slice(i));
        i += braced ? braced[0].length - 1 : next === 'x' ? 3 : next === 'u' ? 5 : 1;
      } else {
        out += '()|[]'.includes(next) ? '\0' : ch + next;
        i++;
      }
    } else if (ch === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++) if (source[i] === '\\') i++;
      out += '\0';
    } else out += ch;
  }
  return out;
}

function regexFindings(source: string, flags: string): Kind[] {
  const literal = literalPart(source);
  const kinds: Kind[] = [];
  if (THAI_LETTER.test(literal)) kinds.push('thai-regex');
  if (flags.includes('i')) {
    for (const group of literal.matchAll(/\((?:\?(?::|=|!|<=|<!|<[A-Za-z]+>))?([^()]*)\)/g)) {
      // A file-extension list (\.(png|jpe?g|gif)) names formats, not meanings.
      if (/\\\.\s*$/.test(literal.slice(0, group.index))) continue;
      const alternatives = group[1].split('|').map(alt => alt.replace(/\\b/g, '').trim());
      if (alternatives.length >= 3 && alternatives.filter(alt => PLAIN_WORD.test(alt)).length >= 3) { kinds.push('english-words'); break; }
    }
  }
  return kinds;
}

const isThaiWord = (node: ts.Node) => ts.isStringLiteralLike(node) && /^[\u0E00-\u0E7F]{1,20}$/.test(node.text);
const isShortString = (node: ts.Node) => ts.isStringLiteralLike(node) && node.text.length <= 24;

export function scanSource(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const add = (node: ts.Node, kind: Kind, source: string) => findings.push({
    file, kind, source, line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  });
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = node.getText(sourceFile), end = literal.lastIndexOf('/');
      for (const kind of regexFindings(literal.slice(1, end), literal.slice(end + 1))) add(node, kind, literal.slice(1, end));
    } else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'RegExp') {
      const [pattern, flags] = node.arguments ?? [];
      if (pattern && ts.isStringLiteralLike(pattern)) {
        for (const kind of regexFindings(pattern.text, flags && ts.isStringLiteralLike(flags) ? flags.text : '')) add(node, kind, pattern.text);
      }
    } else if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2 && node.elements.every(isShortString) && node.elements.some(isThaiWord)) {
      add(node, 'thai-words', node.elements.map(element => (element as ts.StringLiteralLike).text).join('|'));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/** Existing matches per file and kind, each with its reason. `structural` entries parse formats
 * the gateway or a provider defines; they are not natural-language interpretation. `debt` entries
 * ARE semantic heuristics that predate the rule: migrate them to a structured signal, then lower
 * the count or delete the entry. Never add a `debt` entry or raise its count. A count above what
 * the file still contains fails the test too, so the list can only shrink. */
const ALLOWED: Array<{ file: string; kind: Kind; count: number; category: 'structural' | 'debt'; reason: string }> = [
  // ── structural ────────────────────────────────────────────────────────────
  { file: 'src/agent/dreaming/migrate.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Fixed MEMORY.md h2 section names that memory files use.' },
  { file: 'src/cli/redact.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Secret redaction: credential key names.' },
  { file: 'src/orchestration/provider-message.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Secret redaction: credential key names.' },
  { file: 'src/safemode/context.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Secret redaction: credential key names.' },
  { file: 'src/orchestration/inference-errors.ts', kind: 'english-words', count: 3, category: 'structural', reason: 'Provider error messages: machine-generated protocol text that carries no error code, not user or model language.' },
  { file: 'src/session/codex-native-mcp-client.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'JSON-RPC notification method names of the Codex MCP protocol.' },
  { file: 'src/share/session-image-catalog.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Placeholder tokens such as "(photo)" that channel receivers write for captionless media.' },
  { file: 'src/share/session-video-catalog.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Placeholder tokens such as "(photo)" that channel receivers write for captionless media.' },
  { file: 'src/telegram/markdown.ts', kind: 'english-words', count: 1, category: 'structural', reason: 'Telegram HTML tag names.' },
  // ── debt: semantic heuristics to migrate (issue #629) ─────────────────────
  // Group B: direct Browser/Computer command shortcuts that parse user phrasing (PR #525, #570).
  { file: 'src/automation/browser-command.ts', kind: 'thai-regex', count: 3, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/command-steps.ts', kind: 'thai-regex', count: 5, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/command-steps.ts', kind: 'english-words', count: 2, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/computer-command.ts', kind: 'thai-regex', count: 4, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/computer-command.ts', kind: 'thai-words', count: 11, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/computer-safety.ts', kind: 'thai-regex', count: 2, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/direct-command.ts', kind: 'thai-regex', count: 12, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/direct-command.ts', kind: 'thai-words', count: 1, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  { file: 'src/automation/direct-command.ts', kind: 'english-words', count: 3, category: 'debt', reason: 'Direct-command shortcut that parses user phrasing (group B).' },
  // Group C: the audio-tag vocabulary matched in model text.
  { file: 'src/voice/audio-tags.ts', kind: 'english-words', count: 1, category: 'debt', reason: 'Audio-tag vocabulary matched in model text (group C).' },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const root = join(__dirname, '..', '..');
const findings = sourceFiles(join(root, 'src')).flatMap(path => scanSource(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8')));
const counts = new Map<string, Finding[]>();
for (const finding of findings) counts.set(`${finding.file} ${finding.kind}`, [...counts.get(`${finding.file} ${finding.kind}`) ?? [], finding]);
const allowance = new Map(ALLOWED.map(entry => [`${entry.file} ${entry.kind}`, entry.count]));

test('no source file infers meaning from natural-language text with a hardcoded regex or word list', () => {
  const violations = [...counts].filter(([group, found]) => found.length > (allowance.get(group) ?? 0))
    .flatMap(([group, found]) => [`${group}: ${found.length} found, ${allowance.get(group) ?? 0} allowed`,
      ...found.map(finding => `  line ${finding.line}  /${finding.source.slice(0, 100)}/`)]);
  // Fix: replace the heuristic with a model-declared structured field, real system state or an
  // explicit command (see AGENTS.md). Only a pattern that parses a format, not meaning, may be
  // added to ALLOWED as `structural`, with its reason.
  expect(violations).toEqual([]);
});

test('every allowlist count is exact, so the list can only shrink', () => {
  const stale = ALLOWED.filter(entry => (counts.get(`${entry.file} ${entry.kind}`)?.length ?? 0) < entry.count)
    .map(entry => `${entry.file} ${entry.kind}: ${counts.get(`${entry.file} ${entry.kind}`)?.length ?? 0} found, lower the count to match`);
  expect(stale).toEqual([]);
});

describe('the scanner', () => {
  const kinds = (code: string) => scanSource('fixture.ts', code).map(finding => finding.kind);

  test('flags the shapes of a semantic heuristic', () => {
    // The promise detector removed in issue #629.
    expect(kinds(String.raw`const THAI = /(?:จะ|เดี๋ยว)(?:\s*(?:ผม|ฉัน|เรา))*\s*(?:รัน|เริ่ม|ทำต่อ)/g;`)).toEqual(['thai-regex']);
    expect(kinds(String.raw`const EN = /\b(?:I(?:'ll| will)|let me)(?:\s+(?:now|then|also|just))*\s+(?:re-?run|run|retry)\b/i;`)).toEqual(['english-words']);
    // The skill-learning correction trigger removed in issue #629.
    expect(kinds(String.raw`const CORRECTION_RE = /^\s*(no\b|not\b|wrong\b|that'?s not|nope\b|ไม่ใช่|ผิด|บ่ใช่)/i;`)).toEqual(['thai-regex', 'english-words']);
    expect(kinds(String.raw`const VERB = /^(insert|append|prepend|add|put)\b/i;`)).toEqual(['english-words']);
    expect(kinds(`const r = new RegExp('ถ้า|หาก');`)).toEqual(['thai-regex']);
    expect(kinds(`const STOP = new Set(['ครับ', 'ค่ะ', 'นะ']);`)).toEqual(['thai-words']);
  });

  test('leaves structural parsing alone', () => {
    expect(kinds(String.raw`const thai = /[\u0E00-\u0E7F]/; const t2 = /[฀-๿]/; const t3 = /\p{Script=Thai}/u;`)).toEqual([]);
    expect(kinds(String.raw`const ext = /\.(jpe?g|png|gif|webp)$/i; const json = /^(?:true|false|null)$/;`)).toEqual([]);
    expect(kinds(String.raw`const url = /^https?:\/\/github\.com\/([^/]+)\/(tree|blob)\//; const fence = /^\x60\x60\x60(?:json)?\s*\n/;`)).toEqual([]);
    expect(kinds(`const reply = thai ? 'ยังไม่ได้เริ่มงาน กรุณาลองอีกครั้ง' : 'Not started.'; const one = ['ครับ'];`)).toEqual([]);
  });
});
