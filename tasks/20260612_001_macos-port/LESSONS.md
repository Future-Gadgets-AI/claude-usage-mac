# LESSONS — claude-usage-mac

## Build / toolchain
- **`time` 0.3.48 is a broken release** — `E0119` trait-coherence conflict with `cookie`
  and `tauri-utils`; rustc 1.94/1.95/1.96 all fail identically (so NOT a compiler-version
  issue, despite first appearances). Fix: pin `time = "=0.3.47"`. Reusable trick:
  `cargo check -p cookie` (~30s) reproduces it without a full Tauri build — bisect dep/
  toolchain problems on the smallest crate that triggers them.
- **A piped background command's exit code is the pipe's last stage, not the real command.**
  `cargo ... | tail` reports `tail`'s 0 even on a compile failure. Always read the actual output.
- **cwd resets between calls in this environment** — use absolute paths, `--manifest-path`,
  `npm --prefix`. A `cd`-less command silently runs in the wrong directory (hit 3×).

## Product mistakes
- **`visible:true` + `alwaysOnTop:true` borderless window parked itself over the user's
  fullscreen game.** I deviated from the planner's explicit "visible:false at boot" gate for
  "dev convenience" on a machine the user was actively using. Lesson: honor intrusive-UI gates;
  default to non-intrusive (tray-click to show), and never auto-launch a GUI onto someone's
  active screen without a heads-up.

## Porting traps (the planner caught these; re-check on any API-backed UI)
- **R6 — key translation:** the API returns `five_hour`/`seven_day_sonnet`; the log + reader
  use `5h`/`sonnet_7d`. A mismatch = **silently empty graphs while everything else looks fine.**
- **R8 — tier scale:** the credit-limit lookup must thread the real `tier`, or it falls back to
  Pro limits and the graph axis is ~15× off but plausible-looking.
- **R1 — duplicated math:** the cumulative split was computed twice in the source (y-max
  precompute + draw). Port to ONE shared helper (`walkCumulative`) so they cannot drift.

## Architecture / process wins
- **All I/O + network in Rust; the token never enters JS.** Cleaner and more secure than the
  original (which read the token in the extension). It was *forced* by a constraint — the
  webview silently drops the spoofed `User-Agent` header that the endpoint requires — which
  turned a limitation into a better design. Surface constraints early; they often point at the
  right architecture.
- **Staged delegation by model tier:** sonnet subagents for the large-but-mechanical work
  (data-core port, plumbing, UI sub-passes 6a/6b/6c), main thread (Fable) for grounding,
  planning, review, and integration. Each sub-pass gated on `npm run build`; the riskiest
  one (P6 UI, ~1100 LOC) was split 6a→6b→6c with a build gate between, never one blind blob.
