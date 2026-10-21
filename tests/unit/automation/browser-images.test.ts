import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { runBrowserUse, type BrowserUseDependencies, type Observation } from "../../../src/automation/browser-use";
import { validateJevRequest } from "../../../src/jev/validation";
import type { JevRequest } from "../../../src/jev/types";

const scope = { device_id: "device", grant_id: "grant", tab_id: "tab" };
type Element = Observation["elements"][number];
const el = (ref: string, label: string, patch: Partial<Element> = {}): Element => ({ ref, label, tag: "button", operations: ["CLICK"], in_viewport: true, ...patch });
const page = (elements: Element[]): Observation => ({
  protocol_version: 1, generation: "g1", url: "https://shop.test/", title: "Shop", text: "Shop page", elements,
  scroll: { up: false, down: false }, truncated: { text: false, elements: false }, navigation: { can_go_back: false, can_go_forward: false },
});
const call = (initial: Observation): BrowserUseDependencies["call"] => async name => {
  if (name === "browser_task_acquire") return { state: "completed", result: { protocol_version: 1, lease_token: randomUUID() } };
  if (name.startsWith("browser_task_")) return { state: "completed", result: {} };
  if (name === "page_observe") return structuredClone(initial);
  return { state: "completed", result: { observation: structuredClone(initial) } };
};
/** Every question answered with its given distribution, or certainty on the first option. */
function jev(answers: Record<string, { choice: string; probabilities?: Record<string, number> }> = {}) {
  const requests: Parameters<BrowserUseDependencies["evaluate"]>[0][] = [];
  const evaluate: BrowserUseDependencies["evaluate"] = async request => {
    requests.push(request);
    return { model: "jev-1.14.0", answers: Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
      const given = answers[key], ids = Object.keys(q.criteria), choice = given?.choice ?? ids[0];
      return [key, { choice, confidence: 0.9, probabilities: given?.probabilities ?? Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) }];
    })) };
  };
  return { evaluate, requests };
}
const signal = () => new AbortController().signal;
let viewport: string;
beforeAll(async () => { viewport = (await sharp({ create: { width: 2560, height: 1440, channels: 3, background: "#fff" } }).png().toBuffer()).toString("base64"); });

describe("browser decisions with jev-1.14.0 answers", () => {
  // Regression (#632): jev-1.14.0 names a choice one hundredth below the rounded top; the browser reader threw INVALID_DECISION.
  test("a rounded choice one hundredth below the top is the decision, a wider gap is not", async () => {
    const near = jev({ operation: { choice: "DONE", probabilities: { WAIT: 0.33, DONE: 0.33, BLOCKED: 0.34 } } });
    expect(await runBrowserUse({ goal: "Check the cart", scope }, { call: call(page([])), evaluate: near.evaluate }, signal())).toMatchObject({ status: "needs_verification", reason: "COMPLETION_CANDIDATE" });
    const far = jev({ operation: { choice: "DONE", probabilities: { WAIT: 0.31, DONE: 0.32, BLOCKED: 0.37 } } });
    await expect(runBrowserUse({ goal: "Check the cart", scope }, { call: call(page([])), evaluate: far.evaluate }, signal())).resolves.toMatchObject({ status: "failed" });
  });
});

describe("browser decisions with the tab screenshot (jev.images.enabled)", () => {
  test("each decision carries the viewport, scaled into the Jev limits and referenced from state", async () => {
    const j = jev({ operation: { choice: "DONE" } });
    const screenshot = jest.fn(async () => viewport);
    await runBrowserUse({ goal: "Check the cart", scope }, { call: call(page([el("e1", "Cart")])), evaluate: j.evaluate, screenshot }, signal());
    expect(screenshot).toHaveBeenCalledWith(expect.objectContaining({ ...scope, lease_token: expect.any(String) }), expect.any(AbortSignal));
    const request = j.requests[0];
    expect(request.state.screen).toEqual(Object.keys(request.assets!)[0]);
    const validated = validateJevRequest({ state: request.state, questions: request.questions, assets: request.assets } as JevRequest, { enabled: true, provider: "typesafe", model: "jev-1.13.0", images: { enabled: true } });
    const { width, height } = await sharp(Buffer.from(Object.values(validated.assets!)[0].data_base64, "base64")).metadata();
    expect([width, height]).toEqual([1568, 882]);
  });
  test("a sensitive field in view keeps the screenshot off the request", async () => {
    const j = jev({ operation: { choice: "DONE" } });
    const screenshot = jest.fn(async () => viewport);
    const result = await runBrowserUse({ goal: "Sign in", scope }, { call: call(page([el("pw", "Password", { tag: "input", sensitive: true, operations: ["TYPE_TEXT"] })])), evaluate: j.evaluate, screenshot }, signal());
    expect(screenshot).not.toHaveBeenCalled();
    expect(j.requests[0].assets).toBeUndefined();
    expect(result.trace?.events.some(e => e.reason === "SCREENSHOT_SKIPPED_SENSITIVE")).toBe(true);
  });
  test("in-view elements left out of a truncated observation keep the screenshot off too", async () => {
    const j = jev({ operation: { choice: "DONE" } });
    const screenshot = jest.fn(async () => viewport);
    const truncated = { ...page([el("e1", "Cart")]), truncated: { text: false, elements: true, viewport_elements: true } };
    await runBrowserUse({ goal: "Check the cart", scope }, { call: call(truncated), evaluate: j.evaluate, screenshot }, signal());
    expect(screenshot).not.toHaveBeenCalled();
    expect(j.requests[0].assets).toBeUndefined();
    // Only elements outside the viewport were left out: the screenshot is sent.
    await runBrowserUse({ goal: "Check the cart", scope }, { call: call({ ...truncated, truncated: { text: false, elements: true, viewport_elements: false } }), evaluate: j.evaluate, screenshot }, signal());
    expect(screenshot).toHaveBeenCalledTimes(1);
  });
  test("a sensitive field rendered between the check and the capture keeps the screenshot off", async () => {
    const j = jev({ operation: { choice: "DONE" } });
    let observed = 0;
    const lazy = page([el("pay", "Card number", { tag: "input", sensitive: true, operations: ["TYPE_TEXT"] })]);
    const base = call(page([el("e1", "Cart")]));
    // The payment form appears on the read that follows the capture.
    const racing: BrowserUseDependencies["call"] = async (name, args, s) => name === "page_observe" && ++observed > 1 ? structuredClone(lazy) : base(name, args, s);
    await runBrowserUse({ goal: "Check the cart", scope }, { call: racing, evaluate: j.evaluate, screenshot: async () => viewport }, signal());
    expect(j.requests[0].assets).toBeUndefined();
  });
  test("a failed capture never stops the run: the decision goes ahead on text", async () => {
    const j = jev({ operation: { choice: "DONE" } });
    const result = await runBrowserUse({ goal: "Check the cart", scope }, { call: call(page([el("e1", "Cart")])), evaluate: j.evaluate, screenshot: async () => { throw Error("BROWSER_SCREENSHOT_UNAVAILABLE"); } }, signal());
    expect(result).toMatchObject({ status: "needs_verification", reason: "COMPLETION_CANDIDATE" });
    expect(j.requests[0].assets).toBeUndefined();
    expect(result.trace?.events.some(e => e.reason === "SCREENSHOT_UNAVAILABLE")).toBe(true);
  });
});

/** The extension as it behaves: every read issues a new generation, and an action that carries any other generation
 * is refused before it runs (STALE_OBSERVATION, not executed). */
function rotatingExtension(base: Observation) {
  let generation = 0;
  const actions: string[] = [];
  const fresh = () => ({ ...structuredClone(base), generation: `g${++generation}` });
  const call: BrowserUseDependencies["call"] = async (name, args) => {
    if (name === "browser_task_acquire") return { state: "completed", result: { protocol_version: 1, lease_token: randomUUID() } };
    if (name.startsWith("browser_task_")) return { state: "completed", result: {} };
    if (name === "page_observe") return fresh();
    if (args.generation !== `g${generation}`) return { error: "STALE_OBSERVATION", action_executed: false };
    actions.push(name);
    return { state: "completed", result: { observation: fresh() } };
  };
  return { call, actions };
}

describe("one observation per decision with the tab screenshot", () => {
  // Regression (#632, develop session defe0d1a): the check read after the capture rotated the generation, and the
  // click went out with the older one: CLICK/SCROLL 0/15 after deploy, every one STALE_RETRY_BUDGET.
  test("a click runs on the generation of the observation Jev saw with the picture", async () => {
    const extension = rotatingExtension(page([el("cart", "Cart")]));
    const j = jev({ operation: { choice: "CLICK" }, click_target: { choice: "cart" } });
    const result = await runBrowserUse({ goal: "Open the cart", scope, yieldAfterAction: true }, { call: extension.call, evaluate: j.evaluate, screenshot: async () => viewport }, signal());
    expect(extension.actions).toEqual(["page_click"]);
    expect(result).toMatchObject({ status: "needs_verification", reason: "COMMAND_WAITING_INPUT", lastConfirmedAction: { operation: "CLICK" } });
    expect(j.requests).toHaveLength(1);
    expect(j.requests[0].assets).toBeDefined();
    expect(result.trace?.events.some(e => e.reason === "STALE_OBSERVATION")).toBe(false);
  });
  test("a scroll runs on it too", async () => {
    const extension = rotatingExtension({ ...page([el("cart", "Cart")]), scroll: { up: false, down: true } });
    const j = jev({ operation: { choice: "SCROLL_DOWN" } });
    const result = await runBrowserUse({ goal: "Scroll down", scope, yieldAfterAction: true }, { call: extension.call, evaluate: j.evaluate, screenshot: async () => viewport }, signal());
    expect(extension.actions).toEqual(["page_scroll"]);
    expect(result).toMatchObject({ lastConfirmedAction: { operation: "SCROLL_DOWN" } });
  });
  test("the offered targets come from the observation read after the capture", async () => {
    // The page re-rendered between the previous read and the capture: only the later read's refs exist.
    let reads = 0;
    const extension = rotatingExtension(page([el("cart", "Cart")]));
    const call: BrowserUseDependencies["call"] = async (name, args, s) => {
      const reply = await extension.call(name, args, s);
      return name === "page_observe" && ++reads >= 2 ? { ...(reply as object), elements: [el("cart-2", "Cart")] } : reply;
    };
    const j = jev({ operation: { choice: "CLICK" } });
    await runBrowserUse({ goal: "Open the cart", scope, yieldAfterAction: true }, { call, evaluate: j.evaluate, screenshot: async () => viewport }, signal());
    expect(Object.keys(j.requests[0].questions.click_target.criteria)).toEqual(["cart-2"]);
  });
});
