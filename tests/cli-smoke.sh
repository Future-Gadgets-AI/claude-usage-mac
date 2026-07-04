#!/bin/bash
# Plain-bash smoke tests for bin/claude-usage. No frameworks.
# Each test prints "PASS <name>" or "FAIL <name>: <reason>"; the runner
# exits nonzero if any test failed. t5 is optional and auto-skips when
# there's no real Claude Code keychain item to test against.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$SCRIPT_DIR/../bin/claude-usage"

FAILURES=0

t_pass() {
  printf 'PASS %s\n' "$1"
}

t_fail() {
  printf 'FAIL %s: %s\n' "$1" "$2"
  FAILURES=$(( FAILURES + 1 ))
}

# Runs "$BIN" "$@" under the current (test-supplied) environment and sets
# RUN_STDOUT / RUN_STDERR / RUN_EXIT. Never aborts the runner, whatever the
# CLI's exit code is.
run_cli() {
  local err_file
  err_file="$(mktemp)"
  RUN_STDOUT="$("$BIN" "$@" 2>"$err_file")"
  RUN_EXIT=$?
  RUN_STDERR="$(cat "$err_file")"
  rm -f "$err_file"
}

# Writes a cache file that is already 10 minutes old, with a five_hour
# window resetting 2 hours from now, into $1/usage.json.
write_stale_cache() {
  local dir="$1" fetched_at reset_at
  fetched_at="$(date -u -v-10M +"%Y-%m-%dT%H:%M:%SZ")"
  reset_at="$(date -u -v+2H +"%Y-%m-%dT%H:%M:%S.000000+00:00")"
  cat > "$dir/usage.json" <<EOF
{"schema":1,"fetched_at":"$fetched_at","five_hour":{"utilization":37,"resets_at":"$reset_at"}}
EOF
}

# ---------------------------------------------------------------------------
test_t1_error_path() {
  local name="t1_error_path"
  local tmp
  tmp="$(mktemp -d)"

  # No network is involved here: the credential read fails before the CLI
  # ever reaches the curl call, so this only exercises the keychain path.
  CLAUDE_USAGE_STATE_DIR="$tmp" CLAUDE_USAGE_KEYCHAIN_SERVICE="nonexistent-test-svc-$$" run_cli

  if [[ "$RUN_EXIT" -ne 2 ]]; then
    t_fail "$name" "expected exit 2, got $RUN_EXIT (stderr: $RUN_STDERR)"
  elif [[ "$RUN_STDERR" != *"no-credentials"* ]]; then
    t_fail "$name" "expected stderr to contain no-credentials, got: $RUN_STDERR"
  else
    t_pass "$name"
  fi

  rm -rf "$tmp"
}

test_t2_no_cache() {
  local name="t2_no_cache"
  local tmp
  tmp="$(mktemp -d)"

  CLAUDE_USAGE_STATE_DIR="$tmp" run_cli --cached

  if [[ "$RUN_EXIT" -ne 6 ]]; then
    t_fail "$name" "expected exit 6, got $RUN_EXIT (stderr: $RUN_STDERR)"
  else
    t_pass "$name"
  fi

  rm -rf "$tmp"
}

test_t3_stale_flag() {
  local name="t3_stale_flag"
  local tmp
  tmp="$(mktemp -d)"
  write_stale_cache "$tmp"

  CLAUDE_USAGE_STATE_DIR="$tmp" run_cli --cached

  if [[ "$RUN_EXIT" -ne 0 ]]; then
    t_fail "$name" "expected exit 0, got $RUN_EXIT (stderr: $RUN_STDERR)"
    rm -rf "$tmp"
    return
  fi

  local stale_val util_type mtr_type
  stale_val="$(printf '%s' "$RUN_STDOUT" | jq -r '.stale')"
  util_type="$(printf '%s' "$RUN_STDOUT" | jq -r '.five_hour.utilization | type')"
  mtr_type="$(printf '%s' "$RUN_STDOUT" | jq -r '.minutes_to_reset | type')"

  if [[ "$stale_val" != "true" ]]; then
    t_fail "$name" "expected .stale==true, got $stale_val"
  elif [[ "$util_type" != "number" ]]; then
    t_fail "$name" "expected .five_hour.utilization to be a number, got $util_type"
  elif [[ "$mtr_type" != "number" && "$mtr_type" != "null" ]]; then
    t_fail "$name" "expected .minutes_to_reset to be number or null, got $mtr_type"
  else
    t_pass "$name"
  fi

  rm -rf "$tmp"
}

test_t4_cached_speed() {
  local name="t4_cached_speed"
  local tmp elapsed
  tmp="$(mktemp -d)"
  write_stale_cache "$tmp"

  elapsed="$(
    export CLAUDE_USAGE_STATE_DIR="$tmp"
    TIMEFORMAT='%R'
    { time "$BIN" --cached >/dev/null 2>&1; } 2>&1
  )"

  if awk -v t="$elapsed" 'BEGIN { exit !(t < 1.0) }'; then
    t_pass "$name"
  else
    t_fail "$name" "took ${elapsed}s, expected <1000ms"
  fi

  rm -rf "$tmp"
}

test_t5_happy_live() {
  local name="t5_happy_live"

  if ! /usr/bin/security find-generic-password -s "Claude Code-credentials" -w >/dev/null 2>&1; then
    echo "SKIP $name"
    return
  fi

  local tmp
  tmp="$(mktemp -d)"

  # Only STATE_DIR is overridden (to a temp dir) — KEYCHAIN_SERVICE is left
  # at its real default so this exercises the actual Claude Code credential.
  CLAUDE_USAGE_STATE_DIR="$tmp" run_cli --fresh

  if [[ "$RUN_EXIT" -ne 0 ]]; then
    t_fail "$name" "expected exit 0, got $RUN_EXIT (stderr: $RUN_STDERR)"
    rm -rf "$tmp"
    return
  fi

  local util_type
  util_type="$(printf '%s' "$RUN_STDOUT" | jq -r '.five_hour.utilization | type')"
  if [[ "$util_type" != "number" ]]; then
    t_fail "$name" "expected .five_hour.utilization to be a number, got $util_type"
  else
    t_pass "$name"
  fi

  rm -rf "$tmp"
}

# ---------------------------------------------------------------------------
test_t1_error_path
test_t2_no_cache
test_t3_stale_flag
test_t4_cached_speed
test_t5_happy_live

echo "---"
if [[ "$FAILURES" -gt 0 ]]; then
  echo "$FAILURES test(s) failed"
  exit 1
fi
echo "all tests passed"
exit 0
