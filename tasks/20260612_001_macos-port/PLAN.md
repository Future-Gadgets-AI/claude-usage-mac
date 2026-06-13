# PLAN — macOS Menu-Bar Port (Tasks 4–9)

> Faithful personal-use port of `gustavomoura628/claude-usage-gnome-extension` → Tauri v2 + vanilla-TS + canvas.
> Data core (`src/historyReader.ts`) and Rust backend (`src-tauri/src/lib.rs`) are **done & validated**. This plan covers UI, wiring, config, and verification only. Architecture is **decided** — do not re-litigate.

---

## Ground-truth state (verified 2026-06-12)

| Area | State | Implication |
|---|---|---|
| `historyReader.ts` | DONE — `parseHistory`, `computeHistory(entries, nowMs, …)`, `computeHistoryRange`, `lttb`, `getLimits`, `formatCredits`, `TIER_LIMITS`, `DEFAULT_LIMITS` | Reuse verbatim. I/O is decoupled: **caller** reads log + parses, then calls compute. |
| `lib.rs` | DONE — `get_usage` (raw JSON text), `get_credentials_meta`, `get_status` (raw JSON text), `append_log`, `read_log`. Positioner plugin registered. | No tray, no setup hook, no window-event handler yet. |
| `Cargo.toml` | DONE — `tauri` features `tray-icon` + `macos-private-api`; `tauri-plugin-positioner` feature `tray-icon`; **reqwest is rustls-tls, default-features off**. | TLS choice already settled (rustls). The "native-tls vs rustls" risk is **already resolved** — see Risk R7. |
| `tauri.conf.json` | DEFAULT scaffold — 800×600 titled window, no transparency, no `decorations:false`. | Task 4 is genuinely undone. |
| `main.ts` / `index.html` / `styles.css` | DEFAULT scaffold (greet demo). | Entire frontend is greenfield. |
| `tasks/` dir | did not exist | created by this plan. |

**Critical data-shape facts the UI must honor (from `indicator.js`):**
- Live `get_usage` JSON uses `five_hour.utilization`, `five_hour.resets_at`, `seven_day.*`, `seven_day_sonnet.*`, `seven_day_opus.*`, `seven_day_cowork.*`. These are **API field names**.
- The JSONL log uses **different** keys: `{ts, plan, tier, "5h", "5h_resets", "7d", "7d_resets", sonnet_7d}`. `usageLogger.ts` must **translate** API→log keys. `historyReader.ts` reads the **log** keys.
- `get_credentials_meta` returns `{plan, tier, expiresAt}` — `tier` is the key into `TIER_LIMITS`. Without it the graphs silently fall back to Pro limits (wrong absolute credits at Max tier).
- The cumulative **cumMax precompute** (indicator.js L514–542) lives in the *widget*, not in historyReader. It must be ported into the canvas layer and must use the **same** mid-bar-split logic as the draw pass (L306–357).

---

## Phases

Dependency order is strict: **4 → 5 → 6 → 7 → 8 → 9**, except 4 and 7's Rust-config bits can overlap. #6 is the delegation candidate; #8 is main/interactive only.

| Phase | Task | Where | Depends on | Deliverable |
|---|---|---|---|---|
| **P4** | tauri.conf + capabilities | **main** | — | Borderless transparent popover window config, identifier kept, positioner perms |
| **P5** | Frontend plumbing | **main** | P4 | `apiClient.ts`, `usageLogger.ts`, refresh controller (300/120/1s) |
| **P6** | Cairo → canvas port | **subagent** (staged) | P5 | Panel bars, dropdown, two history graphs, Σ, ◀▶ |
| **P7** | Tray + positioner + dock-hide + blur-hide | **main** | P5 (P6 for visual) | `lib.rs` setup hook + `main.ts` boot |
| **P8** | `tauri dev` live verification | **main / interactive** | P6, P7 | All gates green against live token |
| **P9** | README + polish | **main** | P8 | Reciprocal author note, credit, divergences |

### P4 — Configure `tauri.conf.json` + capabilities (main)
- One window: `label:"main"`, `width:360 height:560` (fits dropdown.png layout; tune in P8), `decorations:false`, `transparent:true`, `resizable:false`, `alwaysOnTop:true`, `visible:false`, `skipTaskbar:true`, `shadow:true`.
- Keep `macos-private-api:true` under `app.security` (already enabled via Cargo feature; conf must opt in: `"macOSPrivateApi": true`).
- Keep identifier `com.claudeusage.menubar`.
- `capabilities/default.json`: add `positioner:default`. **No HTTP/fs frontend caps** — all network/IO is Rust-side.
- Title can stay; it's never shown (borderless).

### P5 — Frontend plumbing (main)
Three small modules + glue. Type hints on every signature (per house style). No drawing here.
- **`apiClient.ts`** — `invoke()` wrappers: `getUsage()`, `getCredentialsMeta()`, `getStatus()`, `appendLog(line)`, `readLog()`. Each does a **defensive** `JSON.parse` inside `try/catch`, tolerating unknown/missing fields (mirror `historyReader`'s "skip-bad, preserve-unknown" stance). Normalize Rust errors (`no-credentials`, `reauth-needed`, `http-NNN`) into a discriminated `{ok:false, error}` union so callers branch without throwing.
- **`usageLogger.ts`** — build the JSONL entry by **translating API keys → log keys**: `five_hour.utilization`→`"5h"`, `five_hour.resets_at`→`"5h_resets"`, `seven_day.*`→`"7d"`/`"7d_resets"`, `seven_day_sonnet.utilization`→`sonnet_7d`; pull `plan`/`tier` from `getCredentialsMeta()`. Include `opus_7d`/`cowork_7d` only when present with a numeric `.utilization` (matches source: logged only if the field exists). Call `appendLog`. Port the source's **dedupe/throttle** (`maybeLog`) so we don't append identical back-to-back snapshots.
- **Refresh controller** — three timers: usage poll **300s**, status poll **120s**, and a **1s** countdown tick that runs **only while the popover is shown** (start on show, stop on hide). Initial fetch on boot. This module owns `_lastData`/`_lastError`/`_lastStatusData` state and notifies the render layer.

### P6 — Cairo → HTML canvas port (**subagent, staged with verify gate between sub-passes**)
This is the highest-variance step (~1100 LOC of draw logic in `indicator.js`). Port to canvas 2D. Honor `devicePixelRatio` (Cairo drew at logical px on a HiDPI-scaled surface; canvas needs explicit `ctx.scale(dpr,dpr)` + backing-store sizing or bars look blurry/misaligned). Reuse `historyReader.ts` for all math; the graph code only **reads log via `readLog()` → `parseHistory()` → `computeHistory`/`computeHistoryRange`**, then draws.

**Sub-pass 6a — panel bars + dropdown skeleton + status dot.** Port `_createPanelBar`/`_updatePanelBar` (fill + white time-marker + blue/amber/red thresholds at 50/80), `_roundedRect`, dropdown bars (`_updateDropdownBar`), countdown formatters (`_formatCountdown`, `_formatPanelCountdown5h/7d`, `_timeMarkerFraction`), per-model rows, service-status dot + component rows + incident line, error line, "Last updated Ns ago". **Gate 6a must pass before 6b.**

**Sub-pass 6b — history graph engine (non-cumulative).** Port `_createHistoryGraph` draw: dark rounded bg, **1x gridlines** (`unitCr` step-doubling loop, L232–248) with `m + 'x'` labels and the fixed-% fallback, time-positioned bars with partial-bucket width (`dur`), bar top-edge, **window boundary lines** (red reset / blue start / purple coincident, ±60s near-match, L382–409), x-axis labels (`_computeXLabels24h`/`_computeXLabels7d`, `_formatHour`, `DAY_NAMES`), avg/peak/total stats line, "No data" centered text. Wire `_updateHistoryGraph` (rolling) for both graphs. **Gate 6b must pass before 6c.**

**Sub-pass 6c — cumulative Σ overlay + ◀▶ navigation.** Port the **cumMax precompute** (L514–542) AND the green-bar draw with **mid-bar reset split** (L306–357) — both must implement identical segment math — plus the dotted-green obscured-level line (L411–432), auto-scale between modes (`_maxVal` vs `cumMax`), the Σ toggle, and `_computeTimeRange('day'|'week', offset)` + `_updateHistoryGraphRange` + nav arrows (◀ increments offset, ▶ decrements, disabled at offset 0, labels "Today"/"This week"/calendar label). Nav resets to offset 0 on popover hide.

> Delegation note: give the subagent `indicator.js`, `historyReader.ts`, `dropdown.png`, `bar.png`, and this phase's gates. Instruct: **port behavior faithfully, do not "improve" the math, preserve the documented source quirks** (e.g. K-branch `toFixed`, peakRate base offset) since the data core already preserved them.

### P7 — Tray + positioner + dock-hide + blur-hide (main)
- **`lib.rs` `setup` hook**: build a `TrayIconBuilder` (use the existing `icons/32x32.png` as a template/menubar icon), on **left-click** toggle the `main` window (show+focus or hide); use `tauri-plugin-positioner` `TrayCenter` (or `TrayBottomCenter`) to anchor the popover under the tray icon. Set `ActivationPolicy::Accessory` so **no Dock icon** appears.
- **Blur-hide**: on `WindowEvent::Focused(false)` for `main`, hide the window.
- **`main.ts` boot**: import all modules, run the refresh controller's initial fetch, hook show/hide → start/stop the 1s countdown + reset nav offsets.
- Keep token logic untouched (read-only; 401 → reauth state).

### P8 — `tauri dev` live verification (**main / interactive — never delegated**)
Run `npm run tauri dev` on the user's real Mac with the live token. Walk every gate below in order. Live oracle currently ≈ **5h 70%, 7d 35%, sonnet_7d 2%**. Cap **3 iterations** per failing gate (see escalation rule). #8 cannot be delegated because it needs the user's Keychain, menu bar, and eyes.

### P9 — README + polish (main)
- Reciprocal author note + credit to `gustavomoura628` and the upstream inspirations (she-llac counter + limits page).
- Document macOS divergences: Keychain (not `~/.claude/.credentials.json`), **read-only token / no refresh** (Claude Code owns lifecycle), canvas (not Cairo), tray popover (not GNOME panel), poll cadence 300/120/1s.
- Polish pass: borderless window has no chrome, so verify nothing relies on a title bar; confirm dark theme matches dropdown.png; remove scaffold (`greet`, demo assets, `tauri.svg`/`vite.svg`/`typescript.svg` if unreferenced).

---

## Definition of Done

The port is **DONE** when, running `npm run tauri dev` on the user's Mac with a live Claude Code token, **all** of the following hold:

1. A **menu-bar (tray) icon** appears; **no Dock icon** is present (`ActivationPolicy::Accessory`).
2. **Left-clicking** the tray icon opens a **borderless, transparent popover anchored under the icon**; clicking again (or clicking away) hides it.
3. The popover shows **5h and 7d progress bars** whose fill **percentages equal the live `get_usage` values exactly (±0 after rounding)**, with the correct **blue/amber/red** color at the 50/80 thresholds and a **white time-position marker** on each bar.
4. The popover shows **live countdown timers** for both windows that **tick every second while open** and stop when hidden.
5. The **per-model (7d) breakdown** appears when the API reports it (currently Sonnet ≈2%) and is hidden otherwise.
6. After the first poll **and** first log append, **both history graphs render non-empty** bars, with **1x gridlines**, correct **x-axis labels** (4-hour marks on 24h; weekday names on 7d), **window boundary lines** (red/blue/purple), and an **avg | peak | total** stats line.
7. Clicking **Σ** overlays the **green cumulative bars** (with mid-bar split where a reset falls inside a bar) and the **dotted-green obscured line**, auto-rescaling the y-axis; clicking again removes it. Both graphs respond.
8. **◀/▶** navigate to previous **calendar-aligned** day (24h graph) / week (7d graph); the period label updates; **▶ is disabled at offset 0**; offsets **reset when the popover hides**.
9. The **service-status dot** reflects `get_status`, and the dropdown lists per-component status (claude.ai / API / Claude Code) plus any active incidents.
10. **Failure states degrade gracefully, never crash:** removing/locking credentials (so `get_usage`→`no-credentials` or `reauth-needed`) shows the **"reopen Claude Code to re-auth"** state; network failure (`http-NNN`/request-failed) shows "API unreachable, will retry"; empty history shows **"No data"** in the graphs.
11. `cargo check`, `npm run build` (tsc+vite), and a clean `tauri build` bundle all succeed. No `console.error` on the happy path. The credentials access token **never appears in any JS value or log**.

---

## Quality gates (per phase — runnable / checkable, verbatim)

**P4 — config**
- [ ] `cargo check` (in `src-tauri`) exits 0.
- [ ] `tauri.conf.json` parses: `npm run tauri dev` starts without a config-schema error.
- [ ] The launched window is **borderless and transparent** (no title bar, no opaque background), `visible:false` at boot (nothing shows until tray wiring in P7).
- [ ] `capabilities/default.json` includes `positioner:default`; no HTTP/fs frontend permissions were added.

**P5 — plumbing**
- [ ] `npm run build` (tsc + vite) exits 0 with **no type errors**; every function signature is type-hinted.
- [ ] `apiClient` parses a real `get_usage` payload and a **truncated/garbage** payload **without throwing** (returns the `{ok:false}` union on bad input).
- [ ] `usageLogger` produces a JSONL line whose keys are exactly `ts, plan, tier, 5h, 5h_resets, 7d, 7d_resets, sonnet_7d` (translated from API keys), and **`opus_7d`/`cowork_7d` are present only when the API reported them**.
- [ ] `usageLogger` does **not** append a duplicate line when usage is unchanged between two polls (dedupe/throttle works).
- [ ] Refresh controller: usage timer fires at 300s, status at 120s, and the 1s countdown timer **only runs while the popover is shown** (verify start-on-show / stop-on-hide via a temporary log/counter).

**P6a — panel bars + dropdown skeleton**
- [ ] `npm run build` exits 0.
- [ ] Panel 5h/7d bar fills, the white time marker, and the 50/80 color thresholds render and match the live percentages **±0**.
- [ ] Bars are **crisp on HiDPI** (no blur / half-pixel seams) — `devicePixelRatio` scaling is applied.
- [ ] Per-model rows, status dot, component rows, incident line, error line, and "Last updated Ns ago" all render with placeholder/live data.

**P6b — graph engine (non-cumulative)**
- [ ] `npm run build` exits 0.
- [ ] With ≥2 logged snapshots, **both graphs render non-empty** bars positioned by time, with partial-bucket width on the current bucket.
- [ ] **1x gridlines** appear at multiples of the Pro limit with `Nx` labels (step doubles as scale grows); the fixed-% fallback path renders when `unitCredits` is 0.
- [ ] **Boundary lines** render with correct colors: **red** at resets, **blue** at window starts, **purple** where they coincide (within 60s).
- [ ] X-axis labels match source: **12am/4am/8am/12pm/4pm/8pm** on the 24h graph; **weekday names** on the 7d graph. Stats line reads `avg X/hr | peak Y/hr | total Z` (24h) and `/day` (7d).
- [ ] Empty history renders centered **"No data"** (not a blank box, not a crash).

**P6c — cumulative + navigation**
- [ ] `npm run build` exits 0.
- [ ] Σ toggle **redraws** green cumulative bars and the y-axis **auto-rescales** between modes; toggling off restores the non-cumulative view. Both graphs respond.
- [ ] A reset falling **mid-bar** splits the green bar into pre/post segments; the **cumMax precompute and the draw pass agree** (the green top never exceeds the auto-scaled max, no clipping/overflow). Sanity-check on the 7d graph where a 5h-window reset lands mid-day.
- [ ] **Dotted-green** line appears where green is obscured by blue (`cumH > 3 && cumH ≤ barH+1`).
- [ ] **◀** changes the displayed period (label updates to the calendar-aligned day/week); **▶** moves back toward present and is **disabled/transparent at offset 0**.

**P7 — tray + window behavior**
- [ ] `cargo check` exits 0; `tauri dev` launches.
- [ ] A **menu-bar icon appears**; **left-click opens the popover anchored under it** (positioner TrayCenter); left-click/away **hides** it.
- [ ] **No Dock icon** is present while the app runs.
- [ ] Popover **hides on focus-loss** (`WindowEvent::Focused(false)`).
- [ ] On popover hide, the 1s countdown stops and nav offsets reset to 0.

**P8 — live verification (the real bar)**
- [ ] `tauri dev` launches clean; tray icon present; popover opens under it; no Dock icon.
- [ ] Panel **5h ≈70% / 7d ≈35%** match `get_usage` exactly; **Sonnet ≈2%** row shows.
- [ ] Both graphs non-empty after first poll **and** first log append; Σ overlay + ◀▶ behave per P6c.
- [ ] Popover hides on blur; reopening restores offset-0 rolling view.
- [ ] **Remove/lock credentials → reauth state, not a crash**; restore → recovers on next poll.
- [ ] Status dot + component rows reflect `get_status`.
- [ ] No access token visible anywhere in DevTools (network/console/storage).

**P9 — docs/polish**
- [ ] `npm run build` and `tauri build` both exit 0 (CLT-only, `~/.cargo/bin` on PATH).
- [ ] README credits `gustavomoura628` + she-llac sources and lists the macOS divergences (Keychain, read-only token, canvas, tray, cadence).
- [ ] Scaffold removed (`greet`, demo SVGs) — no dead references; `npm run build` still 0.

---

## Risks

| # | Risk | Impact | Prob | Mitigation |
|---|---|---|---|---|
| **R1** | **Cumulative mid-bar-split math** (the trickiest logic): cumMax precompute (L514–542) and draw pass (L306–357) drift, causing green bars to overflow the y-axis or mis-split at resets — most likely on the **7d graph** where a 5h reset lands mid-day. | HIGH | HIGH | **CRITICAL.** Port both from the *same* helper, not twice by hand. Dedicated gate (P6c). Verify on the 7d graph specifically. Do **not** refactor the segment loop. |
| **R2** | **`tauri-plugin-positioner` tray-popover anchoring** is rough on macOS — TrayCenter can be off, or the tray-icon rect isn't reported, so the popover lands mis-positioned or off-screen on multi-monitor / notch setups. | HIGH | MED | Isolate in P7; fall back to manual cursor/monitor-relative positioning if TrayCenter is wrong. Verify in P8 on the real menu bar. Cap 3 iters then escalate. |
| **R3** | **Canvas HiDPI scaling vs Cairo**: Cairo drew logical px on a scaled surface; naive canvas draws at CSS px and looks blurry or 0.5px-seamed. Boundary lines / bar edges are the tell. | MED | HIGH | Set backing store to `cssSize * devicePixelRatio`, `ctx.scale(dpr,dpr)`, snap 1px strokes to half-pixels. Gate in P6a. |
| **R4** | **Transparency / vibrancy on macOS 26**: `macos-private-api` transparent windows can render opaque, black, or with a hairline border depending on OS build; vibrancy APIs shift between releases. | MED | MED | Verify transparent borderless window in P4 before building UI on top. If vibrancy is flaky, ship a solid dark `#2a2a2a` popover (matches dropdown.png) — transparency is cosmetic, not required for DoD. |
| **R5** | **First-run empty-history graphs**: only one snapshot exists after first poll, so `filtered.length < 2` → empty points; user may read "No data" as a bug. | LOW | HIGH | Expected behavior; "No data" is a DoD state (DoD #10). In P8, append one synthetic earlier log line (or wait one poll) to exercise the non-empty path. |
| **R6** | **API→log key translation** in `usageLogger`: if the UI logs raw API keys (`five_hour`) instead of log keys (`5h`), `historyReader` reads nothing → permanently empty graphs that *look* fine until inspected. | HIGH | MED | Explicit P5 gate asserting exact log keys. This is the single most likely silent-failure bug. |
| **R7** | **native-tls vs rustls** "already chosen". **Already resolved**: `Cargo.toml` uses `rustls-tls` with `default-features=false` (no OpenSSL/system-tls dep) — correct for CLT-only macOS. | LOW | LOW | None needed. Do **not** switch to native-tls; rustls avoids a system OpenSSL dependency on a no-full-Xcode box. Flagged only to prevent accidental churn. |
| **R8** | **Tier-aware credit scale**: if `get_credentials_meta().tier` isn't threaded into the log's `tier` field, graphs use Pro limits → absolute credits wrong at Max tier (axis labels off by ~6–15×). | MED | MED | P5 gate: log line carries `tier`; spot-check axis `Nx` labels against the live tier in P8. |
| **R9** | **Scope of P6** (~1100 LOC draw) overruns in one delegated shot, producing a hard-to-review blob. | MED | MED | Mandatory 3-way split (6a/6b/6c) with a build+visual gate between each; subagent returns after each sub-pass, main verifies before continuing. |

**Top 3:** R1 (cumulative split math), R2 (positioner anchoring), R6 (API→log key translation). R1 and R6 are *silent* failures (look fine, are wrong); R2 is the most likely *visible* macOS-specific blocker.

---

## Max-iteration cap & escalation

- **Cap: 3 iterations per gate** (one initial attempt + 2 retries). A "gate" is a single checkbox above.
- On the **3rd failure** of any gate, **stop and escalate to the user** with: (a) what was tried, (b) the observed vs expected, (c) the narrowest reproduction, (d) 2–3 options with trade-offs. Do **not** silently widen scope, refactor unrelated code, or weaken the gate to pass.
- **Hard escalation triggers (escalate immediately, don't burn 3 iters):**
  - Any approach would **write to the Keychain** or refresh the token (violates read-only constraint).
  - A gate can only be met by **changing decided architecture** (TLS, poll cadence, all-IO-in-Rust, token-never-in-JS).
  - A fix in P6 requires **changing `historyReader.ts`** (the validated core) — surface it as a finding first; do not edit the core to make the UI pass.
- **Per-phase budget guard:** if P6 (any sub-pass) needs >3 iters on the *same* visual defect, freeze and request a reference screenshot/measurement from the user rather than guessing pixels.
