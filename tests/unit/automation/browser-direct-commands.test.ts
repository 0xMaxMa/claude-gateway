import { randomUUID } from "node:crypto";
import {
  runBrowserUse,
  type BrowserUseDependencies,
  type Observation,
} from "../../../src/automation/browser-use";
import { planBrowserCommand } from "../../../src/automation/browser-command";
import { browserOutcomeText } from "../../../src/automation/browser-outcome";

const scope = { device_id: "device", grant_id: "grant", tab_id: "tab" };
type Element = Observation["elements"][number];
const el = (ref: string, label: string, patch: Partial<Element> = {}): Element => ({
  ref, label, tag: "button", operations: ["CLICK"], in_viewport: true, ...patch,
});
const page = (patch: Partial<Observation> = {}): Observation => ({
  protocol_version: 1, generation: "g1", url: "https://start.test/", title: "Start",
  text: "Start page", elements: [el("e0", "About")], scroll: { up: false, down: true },
  truncated: { text: false, elements: false },
  navigation: { can_go_back: true, can_go_forward: false }, ...patch,
});

/** A scripted Remote Browser extension: every mutation is recorded, never replayed. */
function browser(initial: Observation, effects: Record<string, (args: Record<string, unknown>, current: Observation) => Observation | Record<string, unknown>> = {}) {
  let current = structuredClone(initial), generation = 1;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const observeQueue: Array<Record<string, unknown>> = [];
  const call: BrowserUseDependencies["call"] = async (name, args) => {
    calls.push({ name, args });
    if (name === "browser_task_acquire") return { state: "completed", result: { protocol_version: 1, lease_token: randomUUID() } };
    if (name.startsWith("browser_task_")) return { state: "completed", result: {} };
    if (name === "page_observe") return observeQueue.shift() ?? structuredClone(current);
    const effect = effects[name];
    const next = effect ? effect(args, current) : current;
    if ("error" in next) return next;
    current = { ...(next as Observation), generation: "g" + ++generation };
    return { state: "completed", result: { observation: structuredClone(current) } };
  };
  return { call, calls, observeQueue, mutations: () => calls.filter(c => !c.name.startsWith("browser_task_") && c.name !== "page_observe") };
}
/** Jev stand-in: answers every question with a fixed choice per question key. */
function jev(pick: Record<string, (ids: string[], criteria: Record<string, string>) => string> = {}, confidence = 0.95) {
  const requests: Parameters<BrowserUseDependencies["evaluate"]>[0][] = [];
  const evaluate: BrowserUseDependencies["evaluate"] = async request => {
    requests.push(request);
    return {
      model: "test-jev",
      answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
        const ids = Object.keys(q.criteria);
        const selected = pick[key]?.(ids, q.criteria) ?? (key === "operation" ? "BLOCKED" : ids[0]);
        return [key, { choice: selected, confidence, probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0])) }];
      })),
    };
  };
  return { evaluate, requests };
}
const run = (goal: string, b: ReturnType<typeof browser>, j = jev(), extra: Record<string, unknown> = {}) =>
  runBrowserUse({ goal, scope, command: true, yieldAfterAction: true, ...extra } as never, { call: b.call, evaluate: j.evaluate }, new AbortController().signal);

describe("observation contract (extension 0.3.5+)", () => {
  test("navigation availability and title/url truncation survive parsing", async () => {
    const b = browser(page({ truncated: { text: false, elements: false, title: true, url: false } }));
    const result = await runBrowserUse({ goal: "Check the page", scope }, { call: b.call, evaluate: jev({ operation: () => "DONE" }).evaluate }, new AbortController().signal);
    expect(result.observation?.navigation).toEqual({ can_go_back: true, can_go_forward: false });
    expect(result.observation?.truncated).toMatchObject({ title: true, url: false });
  });
  test("NAVIGATION_PENDING reads are retried on their own budget and nothing is replayed", async () => {
    const b = browser(page());
    for (let i = 0; i < 4; i++) b.observeQueue.push({ error: "STALE_OBSERVATION", cause: "NAVIGATION_PENDING", action_executed: false });
    const result = await runBrowserUse({ goal: "Check the page", scope }, { call: b.call, evaluate: jev({ operation: () => "DONE" }).evaluate }, new AbortController().signal);
    expect(result.reason).not.toBe("STALE_RETRY_BUDGET");
    expect(result.status).toBe("needs_verification");
    expect(b.mutations()).toEqual([]);
    expect(result.trace?.events.filter(e => e.reason === "NAVIGATION_PENDING")).toHaveLength(4);
  }, 15000);
});

describe("direct command fast paths (no Jev round-trip)", () => {
  test("scroll ลง dispatches page_scroll with the observed generation", async () => {
    const b = browser(page(), { page_scroll: (_a, p) => ({ ...p, scroll: { y: 500, up: true, down: true } }) });
    const j = jev();
    const result = await run("scroll ลง", b, j);
    expect(b.mutations()).toEqual([{ name: "page_scroll", args: expect.objectContaining({ direction: "down", generation: "g1", operation_id: expect.any(String) }) }]);
    expect(j.requests).toHaveLength(0);
    expect(result).toMatchObject({ status: "needs_verification", reason: "COMMAND_WAITING_INPUT", commandOutcome: { done: true, action: { kind: "scroll", direction: "down" } } });
    expect(browserOutcomeText(result)).toBe("Done: scrolled down. Send the next command.");
  });
  test("scroll at the bottom is a clear not-done without dispatch", async () => {
    const b = browser(page({ scroll: { up: true, down: false } }));
    const result = await run("scroll down", b);
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toEqual({ done: false, reason: "SCROLL_LIMIT", action: { kind: "scroll", direction: "down" } });
    expect(browserOutcomeText(result)).toBe("Not done: the page is already at the bottom.");
  });
  test.each([["enter", "Enter"], ["กด tab", "Tab"], ["esc", "Escape"], ["ลูกศรลง", "ArrowDown"], ["backspace x3", "Backspace"]])("%s presses %s natively", async (command, key) => {
    const b = browser(page(), { page_keypress: (_a, p) => ({ ...p, text: "after key" }) });
    const result = await run(command, b);
    expect(b.mutations()).toEqual([{ name: "page_keypress", args: expect.objectContaining({ key, generation: "g1" }) }]);
    if (key === "Backspace") expect(b.mutations()[0].args.repeat).toBe(3);
    expect(result.commandOutcome).toMatchObject({ done: true, action: { kind: "key", key } });
  });
  test("กลับ goes back when history allows it", async () => {
    const b = browser(page(), { tab_history: (_a, p) => ({ ...p, url: "https://previous.test/", navigation: { can_go_back: false, can_go_forward: true } }) });
    const result = await run("กลับ", b);
    expect(b.mutations()).toEqual([{ name: "tab_history", args: expect.objectContaining({ direction: "back", generation: "g1" }) }]);
    expect(browserOutcomeText(result)).toBe("Done: went back. Send the next command.");
  });
  test("ไปข้างหน้า without forward history is not done and sends nothing", async () => {
    const b = browser(page());
    const result = await run("ไปข้างหน้า", b);
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toMatchObject({ done: false, reason: "HISTORY_UNAVAILABLE" });
    expect(browserOutcomeText(result)).toBe("Not done: there is no page to go forward to in this tab.");
  });
  test("extension HISTORY_UNAVAILABLE rejection is not-executed, not unknown", async () => {
    const b = browser(page(), { tab_history: () => ({ error: "HISTORY_UNAVAILABLE", action_executed: false }) });
    const result = await run("back", b);
    expect(result.lastAction?.outcome).toBe("not_executed");
    expect(result.commandOutcome).toMatchObject({ done: false, reason: "HISTORY_UNAVAILABLE" });
  });
  test("เข้า google navigates the bound tab", async () => {
    const b = browser(page(), { tab_navigate: (a, p) => ({ ...p, url: String(a.url), title: "Google" }) });
    const result = await run("เข้า google", b);
    expect(b.mutations()).toEqual([{ name: "tab_navigate", args: expect.objectContaining({ url: "https://google.com/" }) }]);
    expect(browserOutcomeText(result)).toBe('Done: opened "https://google.com/". Send the next command.');
  });
  test("ค้นหา X types and submits into the only search field in one operation", async () => {
    const search = el("s1", "Search", { tag: "textarea", role: "combobox", operations: ["CLICK", "TYPE_TEXT"] });
    const b = browser(page({ elements: [search, el("e1", "Sign in")] }), { page_type: (a, p) => ({ ...p, url: "https://google.com/search?q=cat", text: "results for " + a.text }) });
    const j = jev();
    const result = await run("ค้นหา แมวน่ารัก", b, j);
    expect(b.mutations()).toEqual([{ name: "page_type", args: expect.objectContaining({ ref: "s1", text: "แมวน่ารัก", submit: true, replace: true, generation: "g1" }) }]);
    expect(j.requests).toHaveLength(0);
    expect(browserOutcomeText(result)).toBe('Done: searched in "Search". Send the next command.');
  });
  test("with several fields Jev chooses where the search goes", async () => {
    const fields = [el("f1", "Email", { tag: "input", operations: ["TYPE_TEXT"] }), el("f2", "Find products", { tag: "input", operations: ["TYPE_TEXT"] })];
    const b = browser(page({ elements: fields }), { page_type: (_a, p) => ({ ...p, text: "results" }) });
    const j = jev({ field: ids => ids.find(id => id === "f2")! });
    await run("search usb cable", b, j);
    expect(j.requests).toHaveLength(1);
    expect(Object.keys(j.requests[0].questions)).toEqual(["field"]);
    expect(b.mutations()[0].args).toMatchObject({ ref: "f2", text: "usb cable", submit: true });
  });
  test("new tab stays within the approved tab and says so", async () => {
    const b = browser(page());
    const result = await run("เปิด tab ใหม่", b);
    expect(b.mutations()).toEqual([]);
    expect(result).toMatchObject({ status: "needs_verification", reason: "COMMAND_WAITING_INPUT", commandOutcome: { done: false, reason: "NEW_TAB_OUT_OF_SCOPE" } });
    expect(browserOutcomeText(result)).toContain("only in the one tab you approved");
  });
  test("an older extension without navigation data never gets keypress/history primitives", async () => {
    const legacy = page();
    delete legacy.navigation;
    const b = browser(legacy);
    expect((await run("enter", b)).commandOutcome).toMatchObject({ done: false, reason: "KEY_UNSUPPORTED" });
    const j = jev();
    await run("back", b, j);
    expect(b.mutations()).toEqual([]);
    expect(j.requests).toHaveLength(1); // decided from observed controls instead
  });
});

describe("Jev path in command mode", () => {
  test("a click on an observed link reports what was done", async () => {
    const b = browser(page({ elements: [el("l1", "Cute cats - Wikipedia", { tag: "a", role: "link" })] }), { page_click: (_a, p) => ({ ...p, url: "https://en.wikipedia.org/wiki/Cat" }) });
    const j = jev({ operation: () => "CLICK" });
    const result = await run("เข้า link แรก", b, j);
    expect(b.mutations().map(m => m.name)).toEqual(["page_click"]);
    expect(browserOutcomeText(result)).toBe('Done: clicked "Cute cats - Wikipedia". Send the next command.');
  });
  test("no supported action is a Not done outcome that keeps the session waiting", async () => {
    const b = browser(page());
    const result = await run("open the settings drawer", b, jev({ operation: () => "BLOCKED" }));
    expect(result).toMatchObject({ status: "needs_verification", reason: "COMMAND_WAITING_INPUT", commandOutcome: { done: false, reason: "NO_SUPPORTED_ACTION" } });
    expect(browserOutcomeText(result)).toMatch(/^Not done: nothing on the page matches/);
  });
  test("a destructive control needs the command to name it", async () => {
    const b = browser(page({ elements: [el("d1", "Delete account")] }), { page_click: (_a, p) => ({ ...p, text: "deleted" }) });
    const result = await run("click the first button", b, jev({ operation: () => "CLICK" }));
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toMatchObject({ done: false, reason: "DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED", action: { label: "Delete account" } });
    expect(browserOutcomeText(result)).toContain('"Delete account" is a high-impact control');
  });
  test("naming the operation with a confident decision authorizes it", async () => {
    const b = browser(page({ elements: [el("d1", "Delete account")] }), { page_click: (_a, p) => ({ ...p, text: "deleted" }) });
    await run("กด delete account", b, jev({ operation: () => "CLICK" }));
    expect(b.mutations().map(m => m.name)).toEqual(["page_click"]);
  });
  test("low confidence still blocks a named destructive operation", async () => {
    const b = browser(page({ elements: [el("d1", "Pay now")] }));
    const result = await run("pay now", b, jev({ operation: () => "CLICK" }, 0.7));
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome?.reason).toBe("DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED");
  });
  test("previous command context reaches the decision as reference only", async () => {
    const b = browser(page());
    const j = jev({ operation: () => "BLOCKED" });
    await run("the next one", b, j, { interactionContext: "Recorded interaction context: {\"previousCommand\":\"เข้า link แรก\"}" });
    expect(j.requests[0].state.previous_interaction).toContain("เข้า link แรก");
  });
});

describe("command grammar", () => {
  test.each([
    ["scroll ลงมา", { kind: "scroll", direction: "down" }],
    ["เลื่อนขึ้น", { kind: "scroll", direction: "up" }],
    ["enter", { kind: "key", key: "Enter", repeat: 1 }],
    ["กลับ", { kind: "history", direction: "back" }],
    ["ย้อนกลับ", { kind: "history", direction: "back" }],
    ["ไปข้างหน้า", { kind: "history", direction: "forward" }],
    ["ค้นหา แมว", { kind: "search", text: "แมว" }],
    ["search \"red shoes\"", { kind: "search", text: "red shoes" }],
    ["เข้า google", { kind: "navigate", url: "https://google.com/" }],
    ["example.com/docs", { kind: "navigate", url: "https://example.com/docs" }],
    ["เปิด tab ใหม่", { kind: "new_tab" }],
    ["cmd+t", { kind: "new_tab" }],
  ])("%s", (command, plan) => expect(planBrowserCommand(command)).toEqual(plan));
  test.each(["เข้า link แรก", "พิมพ์ hello", "scroll down to the footer and click", "delete", "กด Submit"])("%s stays on the Jev path", command => {
    expect(planBrowserCommand(command)).toBeUndefined();
  });
});

test("a stale search target is re-found by label on the fresh page and sent once more with a new operation", async () => {
  let stale = true;
  const b = browser(page({ elements: [el("s1", "Search", { tag: "input", role: "searchbox", operations: ["TYPE_TEXT"] })] }), {
    page_type: (_a, p) => {
      if (stale) { stale = false; return { error: "STALE_OBSERVATION", action_executed: false }; }
      return { ...p, text: "results" };
    },
  });
  // First read: the field as s1. The re-read after the stale rejection renders it as s2.
  b.observeQueue.push(page({ elements: [el("s1", "Search", { tag: "input", role: "searchbox", operations: ["TYPE_TEXT"] })] }),
    page({ generation: "g9", elements: [el("s2", "Search", { tag: "input", role: "searchbox", operations: ["TYPE_TEXT"] })] }));
  const result = await run("ค้นหา แมว", b);
  const typed = b.calls.filter(c => c.name === "page_type");
  expect(typed.map(c => c.args.ref)).toEqual(["s1", "s2"]);
  expect(typed[0].args.operation_id).not.toBe(typed[1].args.operation_id);
  expect(result.commandOutcome?.done).toBe(true);
});

test("a Jev DONE after the opening navigation reports Done: opened <start url>", async () => {
  const b = browser(page(), { tab_navigate: (a, p) => ({ ...p, url: String(a.url), title: "Google" }) });
  const result = await run("Open google.com and wait", b, jev({ operation: () => "DONE" }), { startUrl: "https://www.google.com/" });
  expect(result.commandOutcome).toEqual({ done: true, action: { kind: "navigate", url: "https://www.google.com/" } });
  expect(browserOutcomeText(result)).toBe('Done: opened "https://www.google.com/". Send the next command.');
});

describe("H2/H1: a confirmed or unresolved action is never reported Not done", () => {
  test("a confirmed navigation whose next page never settles is Done, not a repeat invitation", async () => {
    const b = browser(page());
    let navigated = false;
    const call: BrowserUseDependencies["call"] = async (name, args, signal) => {
      if (name === "tab_navigate") { b.calls.push({ name, args }); navigated = true; return { state: "completed", result: {} }; }
      if (name === "page_observe" && navigated) return { error: "STALE_OBSERVATION", action_executed: false };
      return b.call(name, args, signal);
    };
    const result = await runBrowserUse({ goal: "เข้า google", scope, command: true, yieldAfterAction: true, maxStaleRetries: 1 } as never, { call, evaluate: jev().evaluate }, new AbortController().signal);
    expect(b.mutations()).toHaveLength(1);
    expect(result.lastAction?.outcome).toBe("confirmed");
    expect(result.commandOutcome).toMatchObject({ done: true, reason: "PAGE_STILL_LOADING" });
    expect(browserOutcomeText(result)).toBe('Done: opened "https://google.com/". The page was still loading; check it before the next command.');
  });
  test("an unresolved receipt says the action may have run", async () => {
    const b = browser(page(), { tab_navigate: () => ({ error: "OUTCOME_UNKNOWN" }) });
    const result = await run("เข้า google", b);
    expect(result.lastAction?.outcome).toBe("unknown");
    expect(browserOutcomeText(result)).toMatch(/^Unknown: the last action may have run/);
  });
});

describe("M5: step mode fences Enter and submit like Computer Use", () => {
  const compose = () => page({ elements: [el("body", "Message body", { tag: "textarea", operations: ["TYPE_TEXT"] }), el("send", "Send")] });
  test("Enter on a page with a Send button returns control and sends nothing", async () => {
    const b = browser(compose());
    const result = await run("enter", b, jev(), { strictDestructive: true });
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toMatchObject({ done: false, reason: "DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED", action: { kind: "key", label: "Send" } });
  });
  test("search-and-submit into a non-search field is fenced in step mode", async () => {
    const b = browser(compose());
    const result = await run('ค้นหา "ok"', b, jev(), { strictDestructive: true });
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toMatchObject({ done: false, reason: "DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED" });
  });
  test("a search box still submits in step mode, and direct (non-step) Enter is unchanged", async () => {
    const search = browser(page({ elements: [el("q", "Search", { tag: "input", role: "searchbox", operations: ["TYPE_TEXT"] }), el("send", "Send")] }), { page_type: (_a, p) => ({ ...p, text: "results" }) });
    expect((await run("ค้นหา แมว", search, jev(), { strictDestructive: true })).commandOutcome?.done).toBe(true);
    const direct = browser(compose(), { page_keypress: (_a, p) => ({ ...p, text: "sent" }) });
    expect((await run("enter", direct)).commandOutcome?.done).toBe(true);
  });
});

// Session 3e950913: "อ่านให้ฟังหน่อย ลิเวอร์พูลจะเตะกับใครในแมตช์ถัดไป" under user control
// ended as a 0-step completion candidate and the agent never answered. Jev, not a
// keyword list, now marks such a command READ_REQUEST; nothing is dispatched.
describe("READ_REQUEST: a direct command that asks about the page", () => {
  const ask = "อ่านให้ฟังหน่อย ลิเวอร์พูลจะเตะกับใครในแมตช์ถัดไป";
  const fixtures = () => browser(page({ text: "Liverpool v Arsenal, Saturday 18:30", elements: [el("e0", "Fixtures"), el("e1", "Search", { tag: "input", role: "searchbox", operations: ["TYPE_TEXT"] })] }));
  test("Jev's READ_REQUEST runs no step and reports the read request, not a failed command", async () => {
    const { readRequested, directCommandSpeech } = await import("../../../src/automation/command-speech");
    const b = fixtures(), j = jev({ operation: () => "READ_REQUEST" });
    const result = await run(ask, b, j);
    expect(Object.keys(j.requests[0].questions.operation.criteria)).toContain("READ_REQUEST");
    expect(b.mutations()).toEqual([]);
    expect(result).toMatchObject({ status: "needs_verification", reason: "COMMAND_WAITING_INPUT", steps: 0, commandOutcome: { done: false, reason: "READ_REQUEST" } });
    expect(readRequested({ browserReport: result as never })).toBe(true);
    expect(browserOutcomeText(result)).toMatch(/^Read request:/);
    // The agent answers; no "not done, say it again" line is spoken.
    expect(directCommandSpeech({ browserReport: result as never }, ask, { thai: true })).toBeUndefined();
  });
  test("an uncertain READ_REQUEST keeps the existing not-done behaviour", async () => {
    const { readRequested } = await import("../../../src/automation/command-speech");
    const b = fixtures();
    const result = await run(ask, b, jev({ operation: () => "READ_REQUEST" }, 0.3));
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toEqual({ done: false, reason: "LOW_OPERATION_CONFIDENCE" });
    expect(readRequested({ browserReport: result as never })).toBe(false);
  });
  test("only a single user command is offered READ_REQUEST; a READ_REQUEST answer elsewhere is invalid", async () => {
    for (const extra of [{ command: false }, { strictDestructive: true }]) {
      const b = fixtures(), j = jev({ operation: () => "READ_REQUEST" });
      const result = await run(ask, b, j, extra);
      expect(Object.keys(j.requests[0].questions.operation.criteria)).not.toContain("READ_REQUEST");
      expect(b.mutations()).toEqual([]);
      expect(result.commandOutcome?.reason ?? result.reason).not.toBe("READ_REQUEST");
    }
  });
  test("a malformed READ_REQUEST decision is an invalid decision, never a read request", async () => {
    const b = fixtures();
    const evaluate: BrowserUseDependencies["evaluate"] = async request => ({ model: "test-jev", answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) =>
      [key, key === "operation" ? { choice: "READ_REQUEST", confidence: 0.9, probabilities: { READ_REQUEST: 0.9 } } : { choice: Object.keys(q.criteria)[0], confidence: 0.9, probabilities: Object.fromEntries(Object.keys(q.criteria).map((id, i) => [id, i ? 0 : 1])) }])) });
    const result = await run(ask, b, { evaluate, requests: [] });
    expect(b.mutations()).toEqual([]);
    expect(result.commandOutcome).toEqual({ done: false, reason: "INVALID_DECISION" });
  });
  test("commands that contain the word อ่าน still act as before", async () => {
    const searched = browser(page({ elements: [el("e1", "Search", { tag: "input", role: "searchbox", operations: ["TYPE_TEXT"] })] }), { page_type: (a, p) => ({ ...p, elements: p.elements.map(e => e.ref === a.ref ? { ...e, value: String(a.text) } : e) }), page_keypress: (_a, p) => ({ ...p, url: "https://start.test/?q=1" }) });
    const j = jev();
    const result = await run("ค้นหา อ่านการ์ตูน", searched, j);
    expect(j.requests).toHaveLength(0);
    expect(searched.mutations()).toEqual([{ name: "page_type", args: expect.objectContaining({ ref: "e1", text: "อ่านการ์ตูน", submit: true }) }]);
    expect(result.commandOutcome).toMatchObject({ done: true });
    const typed = browser(page({ elements: [el("e1", "Note", { tag: "input", operations: ["TYPE_TEXT"] })] }), { page_type: (a, p) => ({ ...p, elements: p.elements.map(e => e.ref === a.ref ? { ...e, value: String(a.text) } : e) }) });
    const typing = await run("พิมพ์ อ่านแล้ว", typed, jev({ operation: () => "TYPE_TEXT" }));
    expect(typed.mutations()).toEqual([{ name: "page_type", args: expect.objectContaining({ ref: "e1", text: "อ่านแล้ว" }) }]);
    expect(typing.commandOutcome).toMatchObject({ done: true, action: { kind: "type" } });
  });
});
