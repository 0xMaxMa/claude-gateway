import { runBrowserSteps, type BrowserUseDependencies, type Observation } from "../../../src/automation/browser-use";
import { parseCommandSteps } from "../../../src/automation/command-steps";
import { browserOutcomeText } from "../../../src/automation/browser-outcome";

const scope = { device_id: "device", grant_id: "grant", tab_id: "tab" };
type Element = Observation["elements"][number];
const el = (ref: string, label: string, patch: Partial<Element> = {}): Element => ({ ref, label, tag: "a", role: "link", operations: ["CLICK"], in_viewport: true, ...patch });
const blank = (): Observation => ({
  protocol_version: 1, generation: "g1", url: "https://start.test/", title: "Start", text: "Start page",
  elements: [el("e0", "About")], scroll: { up: false, down: false }, truncated: { text: false, elements: false },
  navigation: { can_go_back: false, can_go_forward: false },
});
const google = (p: Observation): Observation => ({ ...p, url: "https://google.com/", title: "Google", text: "Google",
  elements: [el("q", "Search", { tag: "textarea", role: "combobox", operations: ["CLICK", "TYPE_TEXT"] }), el("lucky", "I'm Feeling Lucky", { tag: "button", role: "button" })],
  scroll: { up: false, down: false }, navigation: { can_go_back: true, can_go_forward: false } });
const results = (p: Observation, query: string): Observation => ({ ...p, url: "https://google.com/search?q=" + encodeURIComponent(query), title: query + " - Google Search",
  text: "Results for " + query, elements: [el("r1", "Cat - Wikipedia"), el("r2", "Cats | National Geographic")], scroll: { up: false, down: true } });
const article = (p: Observation): Observation => ({ ...p, url: "https://en.wikipedia.org/wiki/Cat", title: "Cat - Wikipedia", text: "The cat is a small carnivore",
  elements: [el("x1", "Etymology")], scroll: { up: false, down: true } });

type Effect = (args: Record<string, unknown>, current: Observation) => Observation | Record<string, unknown>;
function browser(initial: Observation, override: Record<string, Effect> = {}) {
  let current = structuredClone(initial), generation = 1;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const observeQueue: Array<Record<string, unknown>> = [];
  const effects: Record<string, Effect> = {
    tab_navigate: (_a, p) => google(p),
    page_type: (a, p) => results(p, String(a.text)),
    page_click: (a, p) => a.ref === "r1" ? article(p) : p,
    page_scroll: (_a, p) => ({ ...p, scroll: { y: 500, up: true, down: true } }),
    ...override,
  };
  const call: BrowserUseDependencies["call"] = async (name, args) => {
    calls.push({ name, args });
    if (name === "browser_task_acquire") return { state: "completed", result: { protocol_version: 1, lease_token: "11111111-1111-4111-8111-111111111111" } };
    if (name.startsWith("browser_task_")) return { state: "completed", result: {} };
    if (name === "page_observe") return observeQueue.shift() ?? structuredClone(current);
    const next = effects[name]?.(args, current) ?? current;
    if ("error" in next) return next;
    current = { ...(next as Observation), generation: "g" + ++generation };
    return { state: "completed", result: { observation: structuredClone(current) } };
  };
  return { call, calls, observeQueue, mutations: () => calls.filter(c => !c.name.startsWith("browser_task_") && c.name !== "page_observe").map(c => c.name) };
}
// Jev picks CLICK on the first observed link (the "first result" stand-in).
const evaluate: BrowserUseDependencies["evaluate"] = async request => ({
  model: "test-jev",
  answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
    const ids = Object.keys(q.criteria), selected = key === "operation" ? (ids.includes("CLICK") ? "CLICK" : "BLOCKED") : ids.find(id => id === "r1") ?? ids[0];
    return [key, { choice: selected, confidence: 0.95, probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0])) }];
  })),
});
const run = (steps: string[], b: ReturnType<typeof browser>, extra: Partial<BrowserUseDependencies> = {}) =>
  runBrowserSteps({ steps, scope }, { call: b.call, evaluate, ...extra }, new AbortController().signal);

test("the user's example runs end to end on one lease: new tab, google, search, first link, scroll", async () => {
  const steps = parseCommandSteps("เปิด tab ใหม่, เข้า google, ค้นหา แมว, เข้า link แรก, scroll ลงมา")!;
  expect(steps).toEqual(["เปิด tab ใหม่", "เข้า google", "ค้นหา แมว", "เข้า link แรก", "scroll ลงมา"]);
  const b = browser(blank());
  const result = await run(steps, b);
  expect(b.mutations()).toEqual(["tab_navigate", "page_type", "page_click", "page_scroll"]);
  expect(b.calls.filter(c => c.name === "browser_task_acquire")).toHaveLength(1);
  expect(b.calls.filter(c => c.name === "browser_task_release")).toHaveLength(1);
  expect(b.calls.find(c => c.name === "page_type")?.args).toMatchObject({ text: "แมว", submit: true });
  expect(result).toMatchObject({ status: "needs_verification", reason: "COMMAND_WAITING_INPUT", steps: 4, evaluations: 1,
    stepRun: { total: 5, completed: 5, stopReason: "ALL_STEPS_DONE", remaining: [], notes: ["Step 1: stayed in the approved tab (no new tab is opened)."] } });
  expect(browserOutcomeText(result)).toBe("5/5 steps done. Step 1: stayed in the approved tab (no new tab is opened).");
});

test("a destructive step returns control before anything runs", async () => {
  const b = browser(google(blank()));
  const result = await run(["ค้นหา แมว", "ลบ account"], b);
  expect(b.mutations()).toEqual(["page_type"]);
  expect(result.stepRun).toMatchObject({ completed: 1, stopReason: "DESTRUCTIVE_STEP", stoppedAt: 2, remaining: ["ลบ account"] });
});

test("a high-impact control chosen for a harmless-looking step is fenced in step mode", async () => {
  const b = browser(google(blank()), { page_type: (_a, p) => ({ ...p, text: "confirm", elements: [el("ok", "OK", { tag: "button", role: "button" })] }) });
  const result = await run(["ค้นหา แมว", "เข้า link แรก"], b);
  expect(b.mutations()).toEqual(["page_type"]);
  expect(result.stepRun).toMatchObject({ completed: 1, stopReason: "DESTRUCTIVE_ACTION", stoppedAt: 2 });
});

test("a read during navigation commit is retried; the search is never resent", async () => {
  const b = browser(google(blank()));
  const pending = { error: "STALE_OBSERVATION", cause: "NAVIGATION_PENDING", action_executed: false };
  const type = b.call;
  let typed = false;
  const call: BrowserUseDependencies["call"] = async (name, args, signal) => {
    const value = await type(name, args, signal);
    // The search result page is still committing right after Enter.
    if (name === "page_type") { typed = true; b.observeQueue.push(pending, pending); return { state: "completed", result: {} }; }
    return value;
  };
  const result = await runBrowserSteps({ steps: ["ค้นหา แมว", "เข้า link แรก"], scope }, { call, evaluate }, new AbortController().signal);
  expect(typed).toBe(true);
  expect(b.mutations()).toEqual(["page_type", "page_click"]);
  expect(result.stepRun).toMatchObject({ completed: 2, stopReason: "ALL_STEPS_DONE" });
}, 15000);

test("an action with no observable effect stops the run without resending it", async () => {
  const b = browser(google(blank()), { page_click: (_a, p) => p });
  const result = await run(["เข้า link แรก", "scroll ลง"], b);
  expect(b.mutations()).toEqual(["page_click"]);
  expect(result.stepRun).toMatchObject({ completed: 0, stopReason: "STEP_NO_EFFECT", stoppedAt: 1, remaining: ["scroll ลง"] });
}, 15000);

test("an unknown outcome stops the run for reconciliation", async () => {
  const b = browser(blank(), { tab_navigate: () => { throw Error("socket hang up"); } });
  const result = await run(["เข้า google", "ค้นหา แมว"], b);
  expect(result).toMatchObject({ status: "blocked", reason: "OUTCOME_UNKNOWN", lastAction: { operation: "NAVIGATE", outcome: "unknown" }, stepRun: { stopReason: "OUTCOME_UNKNOWN", stoppedAt: 1 } });
  expect(b.calls.filter(c => c.name === "tab_navigate")).toHaveLength(1);
  expect(b.calls.at(-1)?.name).toBe("browser_task_release");
});

test("a step that finds nothing stops with the remaining steps listed", async () => {
  const b = browser(blank());
  const result = await run(["เข้า link ที่สาม", "scroll ลง"], b, { evaluate: async request => ({ model: "m", answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
    const ids = Object.keys(q.criteria), selected = key === "operation" ? "BLOCKED" : ids[0];
    return [key, { choice: selected, confidence: 0.95, probabilities: Object.fromEntries(ids.map(id => [id, id === selected ? 1 : 0])) }];
  })) }) });
  expect(result.stepRun).toMatchObject({ completed: 0, stopReason: "STEP_NOT_EXECUTED", detail: "NO_SUPPORTED_ACTION", remaining: ["เข้า link ที่สาม", "scroll ลง"] });
  expect(browserOutcomeText(result)).toMatch(/^0\/2 steps done\. Stopped at step 1 "เข้า link ที่สาม": STEP_NOT_EXECUTED \(NO_SUPPORTED_ACTION\): nothing on the page matches/);
});

test("steps are capped like Computer Use (12 steps)", async () => {
  expect(parseCommandSteps(Array.from({ length: 13 }, (_, i) => `${i + 1}. scroll ลง`).join("\n"))).toBeUndefined();
  await expect(runBrowserSteps({ steps: Array(13).fill("scroll ลง"), scope }, { call: async () => ({}), evaluate }, new AbortController().signal)).rejects.toThrow();
});

test("a final step that dispatched nothing keeps the run's last dispatched action (no false OUTCOME_UNKNOWN)", async () => {
  // Real-extension e2e: "กด tab, scroll ลง" on a page already at the bottom.
  const b = browser({ ...google(blank()), scroll: { up: false, down: false } }, { page_keypress: (_a, p) => p });
  const result = await run(["กด tab", "scroll ลง"], b);
  expect(b.mutations()).toEqual(["page_keypress"]);
  const dispatched = b.calls.find(c => c.name === "page_keypress")!.args.operation_id;
  expect(result.lastAction).toEqual({ operationId: dispatched, operation: "KEY", outcome: "confirmed" });
  expect(result.stepRun).toMatchObject({ completed: 2, stopReason: "ALL_STEPS_DONE", unverifiedSteps: [1, 2] });
});

test("opening the address the tab already shows counts as done (E2E: start_url was google.com)", async () => {
  const b = browser(google(blank()), { tab_navigate: (_a, p) => p });
  const result = await run(["เข้า google.com", "ค้นหา getpod"], b);
  expect(b.mutations()).toEqual(["tab_navigate", "page_type"]);
  expect(result.stepRun).toMatchObject({ completed: 2, stopReason: "ALL_STEPS_DONE" });
}, 15000);

test("after a page-changing step the next step waits for the page to settle (E2E: Google results still updating)", async () => {
  let typedAt = 0;
  const changing = () => Date.now() - typedAt < 1200;
  const b = browser(google(blank()), {
    page_click: (a, p) => changing() ? { error: "STALE_OBSERVATION", cause: "FORM_STATE_CHANGED", action_executed: false } : (a.ref === "r1" ? article(p) : p),
  });
  const call: BrowserUseDependencies["call"] = async (name, args, signal) => {
    const value = await b.call(name, args, signal) as Record<string, unknown>;
    if (name === "page_type") typedAt = Date.now();
    // While results are still rendering, every read shows a different page.
    if (name === "page_observe" && changing() && !value.error) return { ...value, generation: "live-" + Date.now(), text: "loading " + Date.now() };
    return value;
  };
  const result = await runBrowserSteps({ steps: ["ค้นหา แมว", "เข้า link แรก"], scope }, { call, evaluate }, new AbortController().signal);
  expect(b.calls.filter(c => c.name === "page_click")).toHaveLength(1);
  expect(result.stepRun).toMatchObject({ completed: 2, stopReason: "ALL_STEPS_DONE" });
}, 20000);

test("L6: a binding's whole-run maxSteps is honored instead of a hardcoded per-part budget", async () => {
  const b = browser(blank());
  const result = await runBrowserSteps({ steps: ["เข้า google", "ค้นหา แมว", "scroll ลงมา"], scope, maxSteps: 2 }, { call: b.call, evaluate }, new AbortController().signal);
  expect(b.mutations()).toEqual(["tab_navigate", "page_type"]);
  expect(result.stepRun).toMatchObject({ completed: 2, stopReason: "STEP_NOT_EXECUTED", stoppedAt: 3, detail: "ACTION_BUDGET" });
  expect(browserOutcomeText(result)).toContain("action limit");
});
