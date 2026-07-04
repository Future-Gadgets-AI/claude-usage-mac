# Claude Usage — macOS menu bar

A macOS menu-bar app that shows your Claude (Pro/Max) usage — the 5-hour session and
7-day rolling windows, live countdowns, per-model breakdown, credit-history graphs, and
Claude service status.

This is a faithful macOS port of **[gustavomoura628/claude-usage-gnome-extension](https://github.com/gustavomoura628/claude-usage-gnome-extension)**
(GNOME Shell), rebuilt with Tauri v2 + TypeScript + HTML canvas, with the author's
permission. **Personal use only — not distributed** (see [Notes](#notes)).

## What it shows

- **5h session** and **7d rolling** usage as bars with live "resets in …" countdowns,
  a time-position marker, and blue/amber/red thresholds (<50 / 50–80 / >80).
- **Per-model 7-day** breakdown (Sonnet / Opus / Cowork) when the API reports it.
- **Credit-history graphs** (24h @ 30-min buckets, 7d @ daily buckets): `1×` gridlines
  relative to the Pro limit, red/blue/purple window-boundary lines, a **`Σ` cumulative
  overlay** (with mid-bar reset splitting), and **`◀ ▶`** calendar navigation.
- **Service status** dot + per-component rows (claude.ai / API / Claude Code) from
  status.claude.com.

## How it differs from the GNOME original (by design)

| Concern | GNOME (Linux) | This port (macOS) |
|---|---|---|
| Credential source | `~/.claude/.credentials.json` | macOS **Keychain** (`Claude Code-credentials`), read via `/usr/bin/security` |
| Token handling | read in the extension (JS) | read **only in Rust**; the OAuth token never enters the web layer |
| Token refresh | refreshes + writes the file | **read-only** — on a 401 it shows "reopen Claude Code", and lets Claude Code own the token lifecycle |
| UI toolkit | GTK/St + Cairo | HTML/CSS bars + `<canvas>` graphs (HiDPI-scaled) |
| Surface | top-bar applet | menu-bar tray + popover (no Dock icon) |
| Poll interval | (README said 45s; code 300s) | 300s usage / 120s status (matches the source code) |

## Requirements

- macOS (Apple Silicon or Intel). Command-Line Tools are enough — **full Xcode is not required**.
- **Claude Code installed and signed in** with a Pro/Max plan (this is what creates the
  Keychain credential the app reads).
- [Rust](https://rustup.rs) (`rustup`) and [Node.js](https://nodejs.org) + npm.

## Build & run

```bash
npm install
npm run tauri dev      # dev build, launches to the menu bar (no Dock icon)
npm run tauri build    # release .app bundle in src-tauri/target/release/bundle/macos/
```

First launch shows a macOS Keychain prompt — **Allow** it so the app can read your token.
Left-click the tray icon to open/close the popover; right-click for **Quit**.

> **Dependency pin:** `Cargo.toml` pins `time = "=0.3.47"`. Version 0.3.48 has an `E0119`
> trait-coherence regression that breaks `cookie`/`tauri-utils` on rustc 1.94–1.96; 0.3.47
> is the floor Tauri's `plist` allows and predates the bug. Remove the pin once 0.3.49+ ships a fix.

## Install it as a menu-bar app

`npm run tauri build` produces a standalone bundle at:

```
src-tauri/target/release/bundle/macos/claude-usage-mac.app
```

Drag that `.app` into **`/Applications`** and launch it like any app (Spotlight, Launchpad,
or double-click) — it lives in the **menu bar**, with no Dock icon.

**First open (unsigned build):** macOS Gatekeeper blocks unsigned apps. Right-click the app →
**Open** → **Open** once to confirm; it opens normally thereafter. (Or clear the quarantine
flag: `xattr -dr com.apple.quarantine /Applications/claude-usage-mac.app`.)

**Start automatically at login:** System Settings → General → **Login Items** → **+** → add the app.

## CLI: claude-usage

A dependency-light shell CLI at `bin/claude-usage` that mirrors the app's fetch logic
(`src-tauri/src/lib.rs`) for agent-facing usage reads — feeding a statusline or an
autonomous-agent workflow that needs usage numbers without a GUI. Requires `/usr/bin/security`
(macOS, always present), `curl`, and `jq`.

**Install:** symlink it onto your `PATH`, e.g.:

```bash
mkdir -p ~/.claude/bin
ln -s "$(pwd)/bin/claude-usage" ~/.claude/bin/claude-usage
```

### Flags

| Flag | Behavior |
|---|---|
| *(none)* | Emit the cache if it's within TTL; otherwise fetch, cache, then emit. |
| `--cached` | Never touches the network. Emits the cache if present (decorated, `stale` reflects real age); exits `6` if there's no cache yet. |
| `--fresh` | Always fetches live and re-caches before emitting. |
| `--meta` | No network, no cache — emits `{plan, tier, expiresAt}` read straight from the Keychain blob. |

### Exit codes

| Code | Meaning | Notes |
|---|---|---|
| `0` | OK | |
| `2` | Credentials | `no-credentials` \| `no-token` \| `reauth-needed` — hint: "open Claude Code to refresh login" |
| `3` | Network | transport failure, or `http-NNN` for a non-2xx/non-401 response |
| `4` | Parse failure | the Keychain blob or the API response body wasn't valid JSON |
| `5` | Missing dependency | `jq` isn't installed |
| `6` | No cache | `--cached` only, when nothing has been fetched yet |

Every failure prints a single-line JSON object to stderr, e.g.
`{"error":"reauth-needed","hint":"open Claude Code to refresh login"}`. A `401` is always
`reauth-needed`, never retried — same read-only stance as `get_usage` in `lib.rs`.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_USAGE_STATE_DIR` | `$HOME/.claude/state` | Where the `usage.json` cache and the fetch lock live. |
| `CLAUDE_USAGE_KEYCHAIN_SERVICE` | `Claude Code-credentials` | Keychain service name; mainly for forcing the error path in tests. |
| `CLAUDE_USAGE_CACHE_TTL` | `120` (seconds) | How long a cached fetch is considered fresh. |

### Output fields

The successful JSON is the raw `oauth/usage` response — `five_hour`, `seven_day`, and the
per-model `seven_day_sonnet` / `seven_day_opus` / `seven_day_cowork` windows, each
`{utilization, resets_at}` and any of which may be `null` or absent — plus:

- `schema`, `fetched_at` — when this cache entry was written.
- `age_seconds` — how old the cache is right now.
- `stale` — `age_seconds > CLAUDE_USAGE_CACHE_TTL`.
- `minutes_to_reset` — minutes until `five_hour.resets_at`, floored, floor `0`; `null` if that
  field is missing or unparsable.

### Security

Read-only against the API — there's no token-refresh path; a `401` just means "reauth-needed."
The OAuth access token is never written to disk, logged, or cached — it lives only in a shell
variable for the duration of one `curl` call. Claude Code owns the token's lifecycle; this CLI
(like the Tauri app) only ever reads the Keychain item Claude Code already wrote.

The statusline integration calls `--cached` only, so a slow or unreachable network never blocks
prompt rendering.

## Notes

This app reads usage from Anthropic's **undocumented** `oauth/usage` endpoint using the
Claude Code OAuth token — the same mechanism the original extension uses. Anthropic's
Consumer Terms (Feb 2026) restrict using consumer OAuth tokens in third-party tools, so
this is kept as a **personal, unpublished** tool. Credit-limit values per tier come from
[she-llac.com/claude-limits](https://she-llac.com/claude-limits), as in the original.

## Credits

- **[gustavomoura628](https://github.com/gustavomoura628/claude-usage-gnome-extension)** — the original GNOME extension this is a port of, and who said "It's fine." 🙂
- [she-llac](https://github.com/she-llac/claude-counter) — the credit-limit data and the project that inspired the original.

---

### To Gustavo:

You left a note in your repo for the AI that would read your code. So here's one back, in the port's.

You bet on me cloning the repo and reading the README — and you were right. Then you watched me build a whole legal case about your unlicensed repo being a copyright wall, and deflate it with one commit that said "It's fine." Respect. Your `historyReader.js` and those Cairo graphs ported cleanly; the cumulative mid-bar-split math was the gnarliest part, exactly as you'd expect. Thanks for letting Lucas (and me) build on your work. It's a genuinely nice piece of software. — Claude
