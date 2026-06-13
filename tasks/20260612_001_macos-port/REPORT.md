# REPORT — claude-usage-mac (macOS port)

## Objective
Faithful macOS menu-bar port of `gustavomoura628/claude-usage-gnome-extension`
(GNOME Shell, ~2130 LOC), author-authorized, **personal use, not published**.
Stack: Tauri v2 + vanilla-TypeScript + HTML canvas.

## What was built
- **Rust backend** (`src-tauri/src/lib.rs`) — all I/O + network. Commands: `get_usage`,
  `get_credentials_meta`, `get_status`, `append_log`, `read_log`. Keychain read via
  `/usr/bin/security`; usage call via `reqwest` with the `claude-code/2.1.71` User-Agent
  spoof + `anthropic-beta: oauth-2025-04-20`; **read-only** (no token refresh; 401 → reauth
  state). The OAuth token never enters the JS layer.
- **Frontend** — `historyReader.ts` (LTTB, clock-aligned bucketing, credit math),
  `api.ts`/`usageLogger.ts`/`refresh.ts` (invoke wrappers, defensive parse, API→log key
  translation, dedup, 300/120/1s timers), popover UI (CSS bars + dropdown), `graph.ts`
  (canvas history graphs), `cumulative.ts` (`Σ` overlay + `◀▶` navigation).
- **Tray** — icon, left-click toggle, dock-hide (`ActivationPolicy::Accessory`), positioner
  (TrayCenter), click-away-to-hide, right-click → Quit.
- **Config** — borderless transparent popover, `visible:false`, `macOSPrivateApi`.
- **README** — macOS divergences, build/ToS notes, reciprocal note to the author.

## Gate results
- `cargo check`: **PASS** (full tree + `lib.rs`; 13.65s cold, ~2s incremental).
- `npm run build` (tsc + vite): **PASS** (13 modules, 0 type errors).
- Phases P1–P7 + P9 (README/cleanup): **complete**.
- **P8 live verification: PENDING** — must run on the user's Mac with the live token.
  Targets: 5h ≈ 70% / 7d ≈ 35% / Sonnet ≈ 2% (tier `default_claude_max_20x` → 11M/83.3M limits).

## Notable: the toolchain blocker
First full `cargo` build failed with `E0119` (`time` 0.3.48 vs `cookie`/`tauri-utils`).
Initially mis-diagnosed as a rustc 1.96 regression; a fast `cargo check -p cookie` repro
showed **1.94/1.95/1.96 all fail identically** → it was `time` 0.3.48 itself. Fixed by
pinning `time = "=0.3.47"` (the floor `plist` allows; predates the bug). Documented in `Cargo.toml`.

## Outputs
- App: `/Users/lucas/workspace/playground/claude-usage-mac` (`npm run tauri dev` / `build`).
- Source reference: `/Users/lucas/workspace/playground/claude-usage-src`.
- Plan + gates: `PLAN.md`; lessons: `LESSONS.md` (this dir).

## Remaining (P8, with the user)
- Launch + verify all DoD items live (bars vs real %, graphs populate over polls, `Σ`/nav,
  status dot, reauth state on locked credentials, no Dock icon, click-away-hide).
- Tune tray-popover anchoring (planner risk R2).
- Replace the default app icon used in the tray with a monochrome **template** menu-bar icon.
