/**
 * Surface-agnostic step-list grammar shared by Computer Use and Remote Browser
 * step mode. Pure: parses the user's own text, never page or window content.
 */
export const COMMAND_STEPS_MAX = 12;
export const COMMAND_STEPS_TIMEOUT_MS = 120000;
export const STEP_TEXT_MAX = 300;

export type CommandStepStopReason =
  | 'ALL_STEPS_DONE' | 'STEP_NO_EFFECT'
  | 'STEP_NOT_EXECUTED' | 'OUTCOME_UNKNOWN' | 'TIMEOUT' | 'CANCELLED' | 'FAILED';
/** Parent-facing summary. Step text is the user's own command, never app content. */
export interface CommandStepRun {
  total:number; completed:number; stopReason:CommandStepStopReason;
  /** 1-based step that stopped the run; absent when every step completed. */
  stoppedAt?:number; stoppedStep?:string; detail?:string; remaining:string[];
  /** 1-based scroll steps dispatched without an observable change. */
  unverifiedSteps?:number[];
  /** Parts of the stopped step that already ran; never resend them. */
  doneParts?:string[];
  /** Owner-facing notes about steps answered without an action (e.g. kept the approved tab). */
  notes?:string[];
}

// Explicit connectors between commands. Thai "แล้ว"/"จากนั้น" must follow
// whitespace so words such as "เสร็จแล้ว" stay inside their step.
const CONNECTOR = /\s+(?:แล้วก็|แล้ว|จากนั้นก็|จากนั้น|(?:and\s+)?then\b)\s*/giu;
// Conditional wording needs reasoning between steps; keep it on the normal path.
const CONDITIONAL = /\b(?:if|unless|until|when|while)\b|ถ้า|หาก|จนกว่า|เมื่อ/iu;

/** Masks quoted payloads so separators inside typed text never split a step. */
function maskQuotes(text:string) {
  return text.replace(/"[^"\n]*"|“[^”\n]*”/gu, quoted => '\u0000'.repeat(quoted.length));
}
function splitAt(text:string, masked:string, pattern:RegExp) {
  const parts:string[] = [];let start = 0;
  for (const match of masked.matchAll(pattern)) {
    parts.push(text.slice(start, match.index));
    start = match.index! + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}
// Pacing notes a delegating agent appends ("start with step 1", "one by one").
const META = /^(?:(?:please\s+)?(?:start|begin)\s+(?:with|from|at)\s+step\s*1\b|(?:do|run|perform)\s+(?:them|these|it|the\s+steps|each\s+step)\s+one\s+(?:by|at\s+a)\s+(?:one|time)\b|one\s+step\s+at\s+a\s+time\b|เริ่ม(?:จาก|ที่|ทำ)?\s*ขั้น(?:ตอน)?ที่\s*1|ทำ(?:ที)?ละ(?:ขั้น|ข้อ|step))/iu;
// Leading role/context sentences, e.g. "You are controlling the user's Mac."
const CONTEXT = /^(?:you\s+are\b|you're\b|คุณ(?:กำลัง|คือ|เป็น))/iu;
const HEADER = /[:：]\s*$/u;
const BULLET = /^\s*[-*•]\s+/u;
const cleanStep = (text:string) => text.trim().replace(/^(?:และ|and)\s+/iu, '').replace(/[.。]+$/u, '').trim();
/** Commands joined inside one listed step, run in order as that step. */
export function stepParts(step:string) {
  const parts = splitAt(step, maskQuotes(step), CONNECTOR).map(cleanStep).filter(Boolean);
  return parts.length ? parts : [step];
}

/** Numbered items of one line: "1. a", "2) b" or inline "1. a 2. b", optionally after a "Steps:" header. */
function numberedItems(line:string) {
  const markers = [...maskQuotes(line).matchAll(/(?:^|\s)(\d{1,2})[.)]\s+/gu)];
  if (!markers.length) return;
  const prefix = line.slice(0, markers[0].index).trim();
  if (prefix && !HEADER.test(prefix)) return;
  // Inline markers split an item only when they continue the sequence in order.
  const run = [markers[0]];
  for (const marker of markers.slice(1)) {
    if (Number(marker[1]) !== Number(run.at(-1)![1]) + 1) break;
    run.push(marker);
  }
  return run.map((m, i) => ({n:Number(m[1]), text:line.slice(m.index! + m[0].length, run[i + 1]?.index ?? line.length)}));
}

/** Explicit list items only; a preamble or header before the list is not a step. Lines are pacing-note free. */
function listSteps(lines:string[]):string[] | undefined | null {
  const items:Array<{n?:number; text:string; line:number}> = [];
  lines.forEach((line, index) => {
    const numbered = numberedItems(line);
    if (numbered) items.push(...numbered.map(item => ({...item, line:index})));
    else if (BULLET.test(line)) items.push({text:line.replace(BULLET, ''), line:index});
  });
  if (!items.length) return null;
  // Mixed numbering and bullets usually means sub-steps; a list must read 1, 2, 3 ...
  if (items.some(item => item.n === undefined) && items.some(item => item.n !== undefined)) return;
  if (items[0].n !== undefined && items.some((item, i) => item.n !== i + 1)) return;
  // Unlisted text between or after items may continue or qualify a step.
  for (let i = items[0].line; i < lines.length; i++) {
    if (lines[i].trim() && !items.some(item => item.line === i)) return;
  }
  return items.map(item => cleanStep(item.text));
}

/** Command lines of an unnumbered request, without a header or leading context. */
function commandLines(lines:string[]) {
  const headers = lines.flatMap((line, i) => HEADER.test(maskQuotes(line)) ? [i] : []);
  if (headers.length > 1) return;
  let body = headers.length ? lines.slice(headers[0] + 1) : lines;
  // Only one command block may follow a header; a second block is extra content.
  const blocks = body.join('\n').trim().split(/\n\s*\n/u).filter(block => block.trim());
  if (headers.length && blocks.length > 1) return;
  // A leading context paragraph before further paragraphs is dropped as a whole.
  while (blocks.length > 1 && CONTEXT.test(blocks[0].trim())) blocks.shift();
  body = blocks.join('\n').split('\n').filter(line => line.trim());
  // Then leading context sentences on the first command line.
  while (body.length && CONTEXT.test(body[0].trim())) {
    const masked = maskQuotes(body[0]);
    const end = masked.search(/[.。!?](?:\s+|$)/u);
    const rest = end < 0 ? '' : body[0].slice(end + 1).trim();
    if (rest) body[0] = rest;else body.shift();
  }
  // An inline header before a one-line list, e.g. "ทำตามขั้นตอนนี้ทีละขั้น: a, b".
  // A URL scheme or time has no space after its colon, so it is never a header.
  const inline = body.length && !headers.length ? /^([^,、，:：]{1,120})[:：]\s+(\S.*)$/u.exec(maskQuotes(body[0])) : null;
  if (inline && !/\/\/|\d$/u.test(inline[1])) body[0] = body[0].slice(body[0].length - inline[2].length);
  return body;
}

/**
 * Returns ordered atomic steps only for an unmistakable explicit step list.
 * A numbered or bulleted list yields exactly its items; otherwise commas and
 * connectors split the command lines. Anything conditional, oversized,
 * single-step or ambiguous stays on the normal path.
 */
export function parseCommandSteps(command:string):string[] | undefined {
  if (typeof command !== 'string' || command.length > 4000) return;
  const lines = command.split(/\r?\n/u).map(line => META.test(line.trim()) ? '' : line);
  // Conditions anywhere, including an ignored preamble, need reasoning between steps.
  if (lines.some(line => CONDITIONAL.test(maskQuotes(line)))) return;
  const listed = listSteps(lines);
  // An empty list item leaves the numbering, and so the user's intent, unclear.
  if (listed === undefined || listed?.some(step => !step)) return;
  const steps:string[] = listed ?? [];
  if (!listed) {
    const body = commandLines(lines);
    if (!body) return;
    for (const line of body) {
      const commas = splitAt(line, maskQuotes(line), /(?<!\d),|,(?!\d)|、|，/gu);
      for (const part of commas) {
        for (const step of splitAt(part, maskQuotes(part), CONNECTOR)) {
          const text = cleanStep(step);
          if (text) steps.push(text);
        }
      }
    }
  }
  if (steps.length < 2 || steps.length > COMMAND_STEPS_MAX) return;
  if (steps.some(step => step.length > STEP_TEXT_MAX || CONDITIONAL.test(maskQuotes(step)))) return;
  return steps;
}
