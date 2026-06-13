// ---------------------------------------------------------------------------
// Ported from indicator.js lines 28–78
// ---------------------------------------------------------------------------

/** Port of _getBarColorClass (indicator.js:28-32) */
export function getBarColorClass(pct: number): 'bar-blue' | 'bar-amber' | 'bar-red' {
  if (pct >= 80) return 'bar-red';
  if (pct >= 50) return 'bar-amber';
  return 'bar-blue';
}

/** Port of _formatCountdown (indicator.js:34-48) */
export function formatCountdown(resetIso: string | null): string {
  if (!resetIso) return '';
  const resetMs = new Date(resetIso).getTime();
  const diffS = Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
  if (diffS <= 0) return 'Resetting...';
  const days = Math.floor(diffS / 86400);
  const hours = Math.floor((diffS % 86400) / 3600);
  const mins = Math.floor((diffS % 3600) / 60);
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h ${mins}m`;
  return `Resets in ${mins}m`;
}

/** Port of _timeMarkerFraction (indicator.js:72-78)
 *  fraction elapsed = 1 − (resetsAt−now) / windowSeconds
 *  clamped to [0,1]; returns 0 when resetIso is null.
 */
export function timeMarkerFraction(resetIso: string | null, windowSeconds: number): number {
  if (!resetIso) return 0;
  const resetMs = new Date(resetIso).getTime();
  const timeUntilReset = Math.max(0, (resetMs - Date.now()) / 1000);
  return Math.min(1, Math.max(0, 1 - timeUntilReset / windowSeconds));
}
