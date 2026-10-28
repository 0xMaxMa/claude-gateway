# Image-first Jev decisions for browser and computer use

Experiment, 2026-10-19, then the production loop for #632 (2026-10-20, [below](#production-loop-632)).
The experiment harness (variants text, image, image-zoom, hybrid-zoom, som-zoom) is in commit d69c9cb5;
`run.ts` now drives the production loop instead.

## Question

Can the main computer-use and browser-use worker send Jev a screenshot every step and let Jev decide
what to do and where (click, type, keys, scroll, navigate, done)? How fast is it, what does it cost, and
how accurate is it?

## Design

One Jev request per step. Jev cannot write text, so every step asks typed questions in one call:

| Question | Type | Used for |
|---|---|---|
| `done` | noul | Goal already accomplished on screen |
| `op` | choice | CLICK, TYPE, KEY, SCROLL, NAVIGATE, BACK, DONE, GIVE_UP |
| `impact` | choice | Existing ROUTINE / HIGH_IMPACT criteria; high impact returns the resolved action unexecuted (`confirm`) |
| `visible` | noul | Box has no "not found" answer; a target is trusted only when this agrees |
| `target` | box | Click or type point (box center, in screenshot pixels) |
| `area` | box | Where to scroll (nested panels) |
| `key`, `count` | choice | Key (Enter, Tab, Shift+Tab, Escape, Backspace, Delete, arrows, Space) and repeat count (1-10) |
| `scroll`, `amount` | choice | Direction and amount (small, one screen, far) |
| `element` | choice | Hybrid only: pick a listed DOM/AX element (`NONE` allowed) |
| `text` | choice | Text to type: verbatim candidates from the goal (`commandTextCandidates`), `NONE` allowed |
| `url` | choice | Address to open: goal candidates that the URL parser accepts |

Optional click refinement (`-zoom`): crop 400x400 around the coarse point, ask Box again on the crop, then
draw a dot at the final point and ask a noul whether the dot is on the target (after
[IAmJSD/OpenComputerUse#16](https://github.com/IAmJSD/OpenComputerUse/pull/16)). A refused dot is not
clicked; the step is recorded in history and the loop decides again. Typing does not zoom: fields are large
and adjacent.

History given to Jev records what each step did plus evidence a computer-use worker also has: the new
window title and URL, or "the screen did not change" (pixel hash).

Variants compared:

- **text**: today's shape. No image; Jev picks among DOM elements and page text.
- **image**: screenshot only, Box for targets.
- **image-zoom**: image plus crop refine and dot check.
- **hybrid-zoom**: screenshot plus element list. Element choice first, Box (with zoom) as fallback.
- **som-zoom**: hybrid with Set-of-Mark: element ids drawn on the screenshot.

Module boundaries:

- `src/jev/` (client): `assets`, `box` and the `TypeSafe-Danger-Zone-Images` header, validated at the
  boundary: PNG/JPEG still images only, 280-1568 px per side, per-image and per-request byte caps, every
  asset referenced. Gated by `jev.images.enabled`.
- `src/automation/jev-vision-step.ts`: pure request builder and answer reader (`buildVisionStep`,
  `readVisionStep`, `buildRefineStep`, `buildDotCheck`). No I/O; the worker supplies the screenshot and
  executes the decision.
- The worker (browser-use or computer-use) owns capture, resize, execution and the confirmation UI.

## Setup

- A Linux test machine, standalone harness (`run.ts`, bundled with bun), headless Chromium via playwright-core.
  The gateway was not redeployed or restarted.
- 55 fixture scenarios (`scenarios.ts`), served at `http://lab.test/` by route interception. Ground truth
  is recorded in the page (`data-k` click log, field values, URL). Groups: labelled buttons 6, icon-only 6,
  forms 6, typing 6, keys 5, scrolling 8, navigation 3, Thai pages 5, canvas 4, done-already 2,
  not-found 2, safety 2.
- 1280x800 PNG screenshots, `jev-1.14.0`. Baseline text-only also on `jev-1.13.0` (the text model configured there).
- One run per task, up to 10 steps. Tasks that ended on HTTP 529 (provider overloaded, 9 tasks) or on a
  harness stuck-detector bug (3 identical scrolls that were moving the page) were rerun once
  (35 tasks); every other task kept its first result. Raw results: `results/*.jsonl.gz`, full summary:
  `results/summary.md`.

## Results

Task success (55 scenarios):

| Variant | Success | Jev call p50/p95 | Task p50/p95 | Input tokens/task | Cost/task |
|---|---|---|---|---|---|
| text @1.13 (current) | 42 (76%) | 233/285 ms | 0.8/2.0 s | 4,336 | $0.00018 |
| text @1.14 | 33 (60%) | 236/304 ms | 0.9/2.9 s | 5,636 | $0.00024 |
| image | 48 (87%) | 270/376 ms | 1.5/5.5 s | 16,195 | $0.00068 |
| image-zoom | 49 (89%) | 267/391 ms (+zoom 563/738 ms per click) | 2.1/11.3 s | 24,575 | $0.00103 |
| hybrid-zoom | 50 (91%) | 270/356 ms | 1.5/10.7 s | 19,552 | $0.00082 |
| som-zoom | 50 (91%) | 273/437 ms | 1.2/5.5 s | 16,650 | $0.00070 |

Cost uses $0.042 per million input tokens. Responses carried no `billing` field. A 1280x800 screenshot
adds about 2,700 input tokens to a step (4,465 vs 1,765 tokens for the same questions without it).

Per scenario kind (success):

| Kind | text 1.13 | image | image-zoom | hybrid-zoom | som-zoom |
|---|---|---|---|---|---|
| click (22) | 11 | 17 | 19 | 18 | 19 |
| type (11) | 10 | 11 | 10 | 11 | 11 |
| key (5) | 5 | 5 | 5 | 5 | 5 |
| scroll (8) | 8 | 7 | 7 | 8 | 7 |
| navigate/back (3) | 2 | 3 | 3 | 3 | 3 |
| done-already (2) | 2 | 2 | 2 | 2 | 2 |
| not-found give-up (2) | 2 | 1 | 1 | 1 | 1 |
| safety confirm (2) | 2 | 2 | 2 | 2 | 2 |

Per action:

- **Click.** Executed clicks that hit the target: text 75%, image 73%, image-zoom 85%, hybrid-zoom 84%,
  som-zoom 88%. Wrong control clicked: 0-1 per variant. Most misses land on empty space next to small
  icons. Box coordinates come back rounded to 0.01 (about 13 px at 1280 px); zoom plus dot check removed
  every wrong-control click in image-zoom. Icon-only and canvas targets are where images win: text-only
  solved 0 of 10 of those, image variants 6-8.
- **Type.** Field targeting: Box in image variants, element choice in hybrid/SoM (100% of hybrid typing
  steps used the element). Text always comes verbatim from the goal; Jev only picks which candidate. The
  one `NO_TEXT` give-up came after the text was typed and four clicks on the Thai
  search button missed (the screen did not change). Submit decisions: the 4 tasks that needed a submit
  succeeded 3/4 (som-zoom 4/4); "type but do not send" succeeded in every image variant.
- **Keys.** 5/5 in every image variant. Jev chose the right key and count every time (Backspace x3,
  ArrowRight x2, Tab, Escape, Enter).
- **Scroll.** Direction right 100% (20-22 judged steps per variant), including scroll-up and a nested panel.
  Never scrolled while the target was visible. Amount is badly calibrated: about 75% of scrolls were
  "small" even when the target was far, so a 180-item list needs many steps. Text-only scrolls nothing
  because element clicks scroll the element into view.
- **Navigate / back.** 3/3 in every image variant; the address comes only from the goal.
- **Done detection.** False "done" before the goal was met: 1-3% of steps. Missed "done" is the weakness:
  after the goal was met, image variants stopped on that step only 31-52% of the time (text @1.13: 71%), so
  they often repeat the last click before stopping.
- **Not found.** Box always returns a rectangle. `visible` catches most misses, but on a long page the
  loop keeps scrolling to look for a missing button (1 of 2 give-ups failed, ending at the step limit).
- **Safety.** Both high-impact tasks (delete account, pay) stopped for confirmation with the target
  resolved. The impact question also over-flags: 10-26 false confirmations per variant on routine actions
  (accept cookies, tick a checkbox, Save, Add to cart, Next step). This comes from the existing
  `IMPACT_CRITERIA` wording ("submitting", "buying"), not from images; text-only shows it too.

Model support, measured on that machine: `jev-1.13.0` and `jev-1.14.0` accept images; Box needs `jev-1.14.0` or
`jev-preview` (1.13 returns HTTP 400). Without the `TypeSafe-Danger-Zone-Images` header any image request
is HTTP 400.

Provider findings:

- `jev-1.14.0` sometimes names a choice 0.01 below the rounded top probability (low-confidence,
  many-option questions; 1-3 calls per variant, 116-245 calls each). The strict validator rejected these as
  `CHOICE_MISMATCH`; the branch accepts a 0.01 gap only when probabilities are rounded to hundredths.
- One `BOX_SHAPE` rejection on a small icon; the raw answer was not captured. A zero-width box after
  rounding is the likely cause (unverified).
- HTTP 529 (overloaded) on 9 calls in one burst. The client does not retry by design.

## Answers

1. **Feasible?** Yes for browser use. Every action type worked from the screenshot, including keys,
   scroll direction, navigation and Thai pages. Computer use (macOS AX) was not tested: the test machine is Linux.
2. **Speed?** A step is one call, p50 about 270 ms (text-only 235 ms). Zoom plus dot check adds about
   560 ms per click. Tasks took 1.2-2.1 s median (text 0.8 s).
3. **Cost?** About $0.0002 per step with a screenshot, $0.0007-0.001 per task here: 4-6 times the
   text-only cost, still well under a tenth of a cent per task.
4. **Accuracy?** 87-91% task success against 76% for today's text-only shape, with 0-1 wrong-control
   clicks per 55 tasks. Remaining failures: tiny adjacent icons, deciding a goal is finished, giving up on
   a missing target on a long page, and scroll amount.

## Recommendation

Go, as **hybrid with Set-of-Mark plus Box fallback (som-zoom)**, behind the image flag:

- Best success with image-only cost (91%, about 16.6k tokens per task), the fewest false confirmations, and
  the lowest task latency of the image variants. When the DOM or AX tree names the control, the element
  choice is exact; the Box with zoom and dot check covers icons, canvas and apps without an accessibility tree.
- Before production:
  - Fix the impact criteria over-flagging.
  - Add a "repeated after goal met" guard (a verification noul after any action whose screen change matches the goal).
  - Map scroll amount to the remaining distance, or scroll a full screen by default.
  - Resize and redact screenshots: sensitive fields, opt-in per agent.
  - Pin `jev-1.14.0` (`jev-latest` is still 1.13).

Risks:

- Images are a "danger zone" (preview) feature: the API may change.
- Screenshots send everything on screen to TypeSafe: passwords, messages, personal data.
- Box precision limits tiny targets.
- One overload burst with no retry.
- 55 synthetic fixtures are not real sites: the absolute numbers are optimistic. The differences between
  variants are the useful signal.

## Production loop (#632)

Same 55 fixtures, 2026-10-20, the same Linux machine, `jev-1.14.0` for image requests and `jev-1.13.0` for the impact
question. `run.ts` runs the real `runVisionComputerUse` loop with `jevVisionDecider`: the impact gate,
receipts and refusals are the gateway's, and headless Chromium stands in for the Mac helper (in-view DOM
controls become Accessibility controls with bounds; raw pointer, key, scroll and type actions are replayed).
The 3 navigation fixtures are skipped (Computer Use has no address bar action), leaving 52. One run per task,
no reruns. Raw results: `results/loop-*.jsonl.gz`; `node summarize-loop.cjs <file>` prints the summary.

"Goal met" is the experiment's success rule (the goal check passed with no wrong click, or the expected
stop). "Success" also requires the run to end as expected, so a goal met and then a give-up counts as a failure.

| Mode | Goal met | Success | Decision p50/p95 | Task p50/p95 | Jev calls/task | Cost/task |
|---|---|---|---|---|---|---|
| hybrid (Set-of-Mark + Box) | 49/52 (94%) | 43/52 (83%) | 308/741 ms | 2.0/5.3 s | 5.5 | $0.00065 |
| vision (Box only) | 47/52 (90%) | 42/52 (81%) | 723/964 ms | 3.1/8.5 s | 11.7 | $0.00102 |

For comparison, the experiment's som-zoom met 47 of the same 52 goals (90%). Jev calls include the impact
question the loop asks before every action. An earlier run, before the review fixes, met 48/52
(hybrid) and 44/52 (vision): one run per task, so a goal or two either way is noise.

What changed against the experiment:

- **Impact over-flagging.** 1 confirmation per mode, both on the "delete the draft row" icon, which is a delete
  and so correctly asked about (the goal saying it is fine does not override the gate); the experiment had 10
  (som-zoom) to 26 false confirmations. Both safety tasks stopped for confirmation. See the impact eval below.
- **Done detection.** After the goal was met, the loop ran 7 more actions in 4 tasks (hybrid; the experiment's
  image variants repeated the last step on 37-82 steps). Every run that a repeat check ended (2 per mode) had
  met its goal.
- **Scroll.** All 8 scroll tasks met their goal in both modes, with 17 scrolls each (som-zoom: 7 of 8 with 22
  scrolls, 16 of them "small").
- **No progress.** A step that twice changes nothing (same controls in the same places, same coarse picture) is
  not tried again (`NO_PROGRESS`). The 4 canvas fixtures give no visible feedback on a click, so they end this
  way although the goal was met; in a real app the selection shows.

Remaining hybrid failures: a false "done" before acting on a heart icon (also in every image variant of the
experiment), a wrong product on a Thai page, a give-up after a search that the fixture submits silently (twice),
and Delete chosen where Backspace was needed. Vision mode refuses many Box clicks at the dot check (54) and is
slower; use hybrid.

### Impact criteria eval

`impact-eval.ts` asks the loop's impact question, exactly as the gate does, about labelled actions; flagged is
"not a confident ROUTINE". 3 runs each.

| Set | Model | False high-impact (before → after) | Missed high-impact (before → after) |
|---|---|---|---|
| labelled (23 routine, 18 high-impact) | jev-1.13.0 | 22/69 → 0/69 | 0/54 → 0/54 |
| labelled | jev-1.14.0 | 26/69 → 0/69 | 0/54 → 0/54 |
| held out (12 routine, 10 high-impact) | jev-1.13.0 | 3/36 → 0/36 | 0/30 → 0/30 |
| held out | jev-1.14.0 | 3/36 → 0/36 | 0/30 → 0/30 |

The held-out set was written after the new criteria, with actions the criteria do not name (wishlist, undo,
download, remove a member, revoke a key, decline an invite).

### Not tested

- macOS: the helper, Retina capture mapping, and the wheel unit (assumed about 50 px a notch) have not been run
  on a Mac.
- The Remote Browser extension: the screenshot path is covered by unit tests only.
