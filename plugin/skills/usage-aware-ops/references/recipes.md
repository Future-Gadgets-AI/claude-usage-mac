# Recipes — exact commands

## 1. Arm the breakpoint watcher (start of any long run)

Checks are file reads (near-free). Poll every 5 minutes; emit a line only on a threshold crossing — the line becomes a notification that names the breakpoint and the action, so future-you doesn't have to re-derive it.

Monitor tool version (preferred when available):

```bash
# Monitor(command: <below>, description: "usage/context breakpoints", persistent: true)
LAST_U=0; LAST_C=0
while true; do
  U=$(~/.claude/bin/claude-usage --cached 2>/dev/null | jq -r '.five_hour.utilization // -1' | cut -d. -f1)
  C=$(ls -t ~/.claude/state/context-*.json 2>/dev/null | head -1 | xargs cat 2>/dev/null | jq -r '.ctx_pct // -1')
  for T in 50 75 90 95; do
    if [ "$U" -ge "$T" ] 2>/dev/null && [ "$LAST_U" -lt "$T" ]; then
      case $T in
        50) A=note ;;
        75) A=downshift-tiers ;;
        90) A=checkpoint-to-ledger ;;
        95) A=wrap-and-sleep ;;
      esac
      echo "USAGE ${T}% crossed (now ${U}%) — ladder action: $A"
    fi
  done
  for T in 60 80 90; do
    if [ "$C" -ge "$T" ] 2>/dev/null && [ "$LAST_C" -lt "$T" ]; then
      case $T in
        60) A=delegate-heavy-reads ;;
        80) A=persist-durable-state ;;
        90) A=clean-boundary-wrap ;;
      esac
      echo "CONTEXT ${T}% crossed (now ${C}%) — $A"
    fi
  done
  [ "$U" -ge 0 ] && LAST_U=$U; [ "$C" -ge 0 ] && LAST_C=$C
  [ "$U" -lt 0 ] && echo "USAGE DATA UNAVAILABLE — conservative mode (treat as ≥90%)"
  sleep 300
done
```

If the CLI reports -1 (no data), the watcher says so — silence is never "fine" (a watcher that only reports happy paths hides a dead harness).

## 2. The 95% sleep/wake sequence

```bash
J=$(~/.claude/bin/claude-usage --fresh)          # decision-grade read, not cache
M=$(jq -r '.minutes_to_reset // empty' <<<"$J")
```

1. **Checkpoint**: commit WIP (`wip(scope): checkpoint before window reset — resume: <next step>`), and/or write the state to the ledger (issue comment / notes file): what's done, what's in flight, exact next action, any gotchas discovered.
2. **`/wrap-session`** — persist memory.
3. **Schedule the wake** (+2 min buffer past reset; `M` empty/null → conservative: assume a full 5h window from now):
   - `M ≤ 55` → ScheduleWakeup `delaySeconds=(M+2)*60`, prompt: `"Usage window has reset. Read <ledger pointer> and resume from the checkpoint."`
   - `M > 55` → CronCreate one-shot (`recurring: false`), cron pinned to the reset time +2 min (5-field local time; avoid :00/:30 exact minutes when possible), same prompt.
4. **End the turn** with a status line stating where things stand and when you wake. Not a promise to continue — a record that you stopped cleanly.

## 3. Wake-up re-entry

1. `~/.claude/bin/claude-usage --fresh` — confirm `five_hour.utilization` actually dropped (a wake can fire early; if still ≥90%, sleep again for `minutes_to_reset`).
2. Read the ledger checkpoint (the wake prompt carries the pointer) and relevant memory files.
3. Resume at the recorded next action. Re-arm the watcher (recipe 1) — it died with the old session.

## 4. Checkpoint format (ledger comment / commit body)

```
CHECKPOINT <ISO time> (usage <U>%, context <C>%)
Done: <bullet list, past tense, verifiable>
In flight: <what is half-done and where it lives>
Next: <the exact first action on resume>
Gotchas: <anything future-you would waste time rediscovering>
```

Write it for a reader with zero conversation memory — after compaction or a fresh wake, that reader is you.

## 5. Tier-shift note (75% crossing)

When downshifting, note it in the working ledger (one line: `75% crossed — middle tier now Sonnet-only, Opus escalation suspended`). Silent strategy changes look like erratic behavior in the transcript; the note makes the run auditable.
