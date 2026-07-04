---
name: usage-aware-ops
description: >
  Resource-aware operations for Claude Code sessions — read usage limits and context-window
  pressure, adapt model tiering to remaining budget, checkpoint before exhaustion, sleep at 95%
  and wake on window reset. Use this skill whenever planning or running long-horizon, unattended,
  overnight, or multi-hour autonomous work; before launching large subagent fan-outs; when the
  user asks about usage limits, remaining budget, "how much do I have left", or session windows;
  when a usage/context breakpoint notification arrives mid-run; or when deciding which model tier
  (Fable/Opus/Sonnet/Haiku) a delegated task should use. Also use it at the START of any dark-factory
  style run to arm the watcher — by 90% it is too late to plan gracefully.
---

# Usage-Aware Operations

A Claude Code session is blind to two budgets that end it: the 5-hour usage window and the context window. This skill gives you eyes on both and the playbook for acting on what you see. The core stance: **degraded data means conservative behavior** — a harness that guesses optimistically is worse than no harness.

## Data sources (both are local file reads — check as often as you like)

**Usage limits** — `~/.claude/bin/claude-usage`:

```bash
~/.claude/bin/claude-usage --cached   # instant, never networks; use this in loops/watchers
~/.claude/bin/claude-usage            # cached if fresh (≤120s), else fetches
~/.claude/bin/claude-usage --fresh    # force fetch; use before big decisions (sleep, tier shift)
```

Key output fields: `five_hour.utilization` (%), `minutes_to_reset`, `seven_day.utilization`, `seven_day_opus.utilization`, `seven_day_sonnet.utilization`, `stale` (cache older than TTL). Exit codes: 0 ok · 1 bad-args · 2 credentials/reauth · 3 network · 4 parse · 5 missing-dependency (jq) · 6 no cache yet.

**Context window** — newest `~/.claude/state/context-*.json` whose `cwd` matches your working directory (the statusline refreshes it about every second):

```bash
ls -t ~/.claude/state/context-*.json | head -5 | xargs cat 2>/dev/null | jq -s --arg cwd "$PWD" '[.[]|select(.cwd==$cwd)][0] // empty'
```

Field `ctx_pct` is your context usage. If no file matches, you're running without a statusline — treat context as unknown and checkpoint more often.

## Usage-limit ladder (five_hour.utilization)

| At | Do |
|----|----|
| <50% | Normal operations |
| 50% | Note it; no behavior change. If a watcher isn't armed yet for a long run, arm it now (recipes) |
| 75% | **Downshift tiers** (table below); defer non-critical work (docs polish, nice-to-haves) to post-reset |
| 90% | **Checkpoint to the ledger** — commit WIP, write issue comments/notes capturing state and next step; take on only atomic work that finishes in minutes |
| 95% | **Stop new work.** Checkpoint → run `/wrap-session` → schedule the wake (recipes: ≤55 min to reset → ScheduleWakeup; more → CronCreate one-shot at reset+2 min) → end the turn with a status line, not a promise |
| wake | Re-read ledger + memory, confirm usage is reset (`--fresh`), resume from the checkpoint |

## Context-window ladder (ctx_pct)

| At | Do |
|----|----|
| <60% | Normal operations |
| 60% | Prefer subagents for heavy reads (repo scans, log dumps) — keep the main context for judgment |
| 80% | Persist durable state to files/ledger; structure remaining work so a compaction survives it (small, self-contained steps with written anchors) |
| 90% | Finish the current unit, persist, and let compaction happen at a clean boundary — never mid-task with unwritten state |

## Elastic model tiering (budget-indexed)

Model choice is a function of remaining budget, not a fixed table. Loop **ends** (vision, decomposition, acceptance) stay on the top model because judgment is where dark factories rot; the **middle** flexes.

| Budget state | Ends (vision/decomposition/acceptance) | Middle (implementation) | Mechanics (fetch/extract/verify) |
|---|---|---|---|
| five_hour <75% | Fable | **Sonnet default**; Opus 4.8 only when the task is genuinely hard AND the Opus budget allows — `seven_day_opus.utilization` < 75, or when that window is `null` (some plans don't expose per-model splits) fall back to `seven_day.utilization` < 75 | Haiku (or Sonnet-low) |
| five_hour ≥75% | Fable, acceptance only | Sonnet | Haiku |

Escalating the middle to Opus buys per-task polish at the cost of runway — for unattended duration, runway usually wins. Check the actual Opus budget before escalating; the CLI gives it to you. Whatever the budget state: **acceptance never skips the top model.** Unreviewed acceptance is how confident garbage ships.

## Conservative mode (fail-safe)

Enter it when: the CLI exits nonzero, `stale: true` on a cache older than ~30 min, or you have no data at all. Behave as if usage ≥90%: checkpoint early and often, no new unattended continuation, tell the human channel what broke (`reauth-needed` → they need to open/re-login Claude Code). Exit it only on a successful `--fresh` read.

## Recipes

Exact commands for arming a watcher, computing the wake, the checkpoint format, and the wake-up re-entry sequence: read [references/recipes.md](references/recipes.md) — do this at the start of any run that might hit a breakpoint, not when the breakpoint fires.

## Setup on a new machine (and after plugin updates)

The CLI ships inside this skill: `scripts/claude-usage` under this skill's base directory (announced when the skill loads). Install it once to the stable path everything references:

```bash
install -m 755 <skill-base>/scripts/claude-usage ~/.claude/bin/claude-usage
```

Then wire the statusline side-write + usage segment — see the repo README (github.com/Future-Gadgets-AI/claude-usage-mac). Without the statusline, context files don't refresh (usage CLI still works). If a copy of this skill exists at `~/.claude/skills/usage-aware-ops`, remove it — the plugin copy is canonical and a duplicate shadows triggering.
