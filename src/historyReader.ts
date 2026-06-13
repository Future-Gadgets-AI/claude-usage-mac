/**
 * historyReader.ts — pure data/compute layer ported from the GNOME Shell extension.
 * All I/O is decoupled: functions accept raw JSONL text or parsed arrays.
 * No GLib/Gio/Cairo dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw log entry written by usageLogger. */
export interface HistoryEntry {
  ts: string;
  plan?: string | null;
  tier?: string | null;
  /** 5-hour utilisation percentage (0–100) */
  '5h'?: number | null;
  '5h_resets'?: string | null;
  /** 7-day utilisation percentage (0–100) */
  '7d'?: number | null;
  '7d_resets'?: string | null;
  /** Per-model 7-day utilisation percentages — may be absent or null */
  sonnet_7d?: number | null;
  opus_7d?: number | null;
  cowork_7d?: number | null;
  /** Tolerate any extra fields the upstream API may add */
  [key: string]: unknown;
}

/** A 2D data point used in chart series and LTTB. */
export interface DataPoint {
  /** Unix timestamp in milliseconds */
  t: number;
  /** Credit value */
  v: number;
}

/** A bucketed bar chart point (includes actual duration for partial-bucket scaling). */
export interface BucketPoint extends DataPoint {
  /** Actual milliseconds of data in this bucket (may be < bucketMs for the final bucket) */
  dur: number;
}

export type UsageField = '5h' | '7d';

/** Per-tier credit limits (verbatim from source). */
export interface TierLimits {
  '5h': number;
  '7d': number;
}

/** Return shape from computeHistory / computeHistoryRange. */
export interface HistoryResult {
  ok: true;
  points: BucketPoint[] | DataPoint[];
  total: number;
  avgRate: number;
  peakRate: number;
  windowStart: number;
  windowEnd: number;
  resetTimes: number[];
}

export interface HistoryError {
  ok: false;
  points: never[];
  avg: number;
  peak: number;
  limit: number;
  error: string;
}

// ---------------------------------------------------------------------------
// Credit limits (verbatim from source — do not alter values)
// ---------------------------------------------------------------------------

export const TIER_LIMITS: Record<string, TierLimits> = {
  'default_claude_max_5x':  { '5h': 3300000,  '7d': 41666700 },
  'default_claude_max_20x': { '5h': 11000000, '7d': 83333300 },
};

/** Pro plan defaults */
export const DEFAULT_LIMITS: TierLimits = { '5h': 550000, '7d': 5000000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getLimits(tier?: string | null): TierLimits {
  if (tier && TIER_LIMITS[tier]) return TIER_LIMITS[tier];
  return DEFAULT_LIMITS;
}

/**
 * Format a credit value for human display.
 * 1500000 → "1.5M", 350000 → "350K", 42 → "42"
 */
export function formatCredits(val: number): string {
  if (val >= 1_000_000) {
    const m = val / 1_000_000;
    return (m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)) + 'M';
  }
  if (val >= 1_000) {
    const k = val / 1_000;
    return k.toFixed(0) + 'K';
  }
  return Math.round(val).toString();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a JSONL text blob into HistoryEntry records.
 * Malformed lines are skipped silently. Unknown fields are preserved via the
 * index signature on HistoryEntry but are not validated.
 */
export function parseHistory(jsonlText: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const raw of jsonlText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('ts' in parsed) ||
      typeof (parsed as Record<string, unknown>).ts !== 'string'
    ) {
      continue;
    }
    entries.push(parsed as HistoryEntry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// LTTB downsampling
// ---------------------------------------------------------------------------

/**
 * Largest-Triangle-Three-Buckets downsampling.
 * Divides (data[1]…data[n-2]) into (target-2) buckets, picks the point in
 * each bucket that forms the largest triangle with the previously selected
 * point and the centroid of the next bucket. Always retains first and last
 * points. Preserves peaks far better than simple averaging.
 */
export function lttb(data: DataPoint[], target: number): DataPoint[] {
  const len = data.length;
  if (target >= len || target < 3) return data.slice();

  const result: DataPoint[] = [data[0]];
  const bucketSize = (len - 2) / (target - 2);
  let prevSelected = 0;

  for (let i = 0; i < target - 2; i++) {
    const bucketStart = Math.floor(i * bucketSize) + 1;
    const bucketEnd = Math.floor((i + 1) * bucketSize) + 1;

    // Centroid of next bucket (triangle far endpoint)
    const nextStart = Math.floor((i + 1) * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, len);
    const nextCount = nextEnd - nextStart;
    let avgT = 0, avgV = 0;
    for (let j = nextStart; j < nextEnd; j++) {
      avgT += data[j].t;
      avgV += data[j].v;
    }
    avgT /= nextCount;
    avgV /= nextCount;

    // Pick the point in the current bucket with the largest triangle area
    const pT = data[prevSelected].t;
    const pV = data[prevSelected].v;
    let maxArea = -1;
    let bestIdx = bucketStart;
    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs(
        (pT - avgT) * (data[j].v - pV) -
        (pT - data[j].t) * (avgV - pV),
      );
      if (area > maxArea) {
        maxArea = area;
        bestIdx = j;
      }
    }

    result.push(data[bestIdx]);
    prevSelected = bestIdx;
  }

  result.push(data[len - 1]);
  return result;
}

// ---------------------------------------------------------------------------
// Delta computation (shared)
// ---------------------------------------------------------------------------

/**
 * Convert a sorted credit-value series into per-sample consumed-credit deltas.
 * If the current value is >= previous, normal accumulation: delta = curr - prev.
 * If the current value dropped, a window reset occurred: delta = curr (credits
 * used since the new window opened).
 */
function computeDeltas(sorted: DataPoint[]): DataPoint[] {
  const deltas: DataPoint[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].v;
    const curr = sorted[i].v;
    deltas.push({ t: sorted[i].t, v: curr >= prev ? curr - prev : curr });
  }
  return deltas;
}

/** Sum deltas, compute avg/peak rates over fixed-size buckets. */
function computeRateStats(
  deltas: DataPoint[],
  windowStart: number,
  rateBucketMs: number,
  numBuckets: number,
): { total: number; avgRate: number; peakRate: number } {
  let total = 0;
  for (const d of deltas) total += d.v;
  total = Math.round(total);

  const avgRate = Math.round(total / numBuckets);

  let peakRate = 0;
  for (let i = 0; i < numBuckets; i++) {
    const bStart = windowStart + i * rateBucketMs;
    const bEnd = bStart + rateBucketMs;
    let bSum = 0;
    for (const d of deltas) {
      if (d.t >= bStart && d.t < bEnd) bSum += d.v;
    }
    if (bSum > peakRate) peakRate = bSum;
  }

  return { total, avgRate, peakRate: Math.round(peakRate) };
}

// ---------------------------------------------------------------------------
// Bucketing helpers
// ---------------------------------------------------------------------------

/**
 * Align a timestamp to a clock boundary.
 * Day-level (bucketMs >= 86 400 000): floor to local midnight.
 * Sub-day: floor to the nearest bucketMs boundary within the calendar day.
 */
function alignToBucket(tsMs: number, bucketMs: number): number {
  if (bucketMs >= 86_400_000) {
    const d = new Date(tsMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const d = new Date(tsMs);
  const dayStart = new Date(d);
  dayStart.setHours(0, 0, 0, 0);
  const msIntoDay = d.getTime() - dayStart.getTime();
  return dayStart.getTime() + Math.floor(msIntoDay / bucketMs) * bucketMs;
}

/** Build a bucketed point series from deltas over [rangeStart, rangeEnd). */
function bucketDeltas(
  deltas: DataPoint[],
  rangeStart: number,
  rangeEnd: number,
  bucketMs: number,
  scalePartial: boolean,
): BucketPoint[] {
  const points: BucketPoint[] = [];
  let bStart = rangeStart;
  while (bStart < rangeEnd) {
    const bEnd = Math.min(bStart + bucketMs, rangeEnd);
    const actualDur = bEnd - bStart;
    let bSum = 0;
    for (const d of deltas) {
      if (d.t >= bStart && d.t < bEnd) bSum += d.v;
    }
    // Scale the current (partial) bucket to full-bucket rate so the chart
    // doesn't understate usage for the in-progress period.
    const v = scalePartial && actualDur < bucketMs
      ? bSum * (bucketMs / actualDur)
      : bSum;
    points.push({ t: bStart, v, dur: actualDur });
    bStart += bucketMs;
  }
  return points;
}

/** Extract reset timestamps (minute-aligned) from a set of entries. */
function extractResets(entries: HistoryEntry[], field: UsageField): number[] {
  const resetSet = new Set<number>();
  for (const e of entries) {
    const resetsIso = e[`${field}_resets`] as string | null | undefined;
    if (resetsIso) {
      const rMs = new Date(resetsIso).getTime();
      if (!isNaN(rMs)) resetSet.add(Math.round(rMs / 60_000) * 60_000);
    }
  }
  return Array.from(resetSet).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Public compute functions (I/O-free)
// ---------------------------------------------------------------------------

/**
 * Compute bucketed usage history for a rolling time window ending now.
 *
 * @param entries    Pre-parsed HistoryEntry array (from parseHistory)
 * @param nowMs      Current time in ms (pass Date.now() from the caller)
 * @param windowMs   Rolling window size in ms (e.g. 24h = 86_400_000)
 * @param field      Which utilisation field to read ('5h' or '7d')
 * @param maxPoints  Max chart points when not bucketing (used with LTTB)
 * @param bucketMs   Bucket width in ms; 0 = use LTTB instead of bucketing
 * @param rateBucketMs  Bucket width for avg/peak rate computation
 */
export function computeHistory(
  entries: HistoryEntry[],
  nowMs: number,
  windowMs: number,
  field: UsageField,
  maxPoints: number,
  bucketMs: number,
  rateBucketMs: number,
): HistoryResult | HistoryError {
  const cutoff = nowMs - windowMs;
  const filtered: DataPoint[] = [];

  for (const entry of entries) {
    const tMs = new Date(entry.ts).getTime();
    if (isNaN(tMs) || tMs < cutoff) continue;

    const pct = entry[field];
    if (pct == null || typeof pct !== 'number') continue;

    const limits = getLimits(entry.tier);
    filtered.push({ t: tMs, v: (pct / 100) * limits[field] });
  }

  const resetTimes = extractResets(
    entries.filter((e) => {
      const tMs = new Date(e.ts).getTime();
      return !isNaN(tMs) && tMs >= cutoff;
    }),
    field,
  );

  if (filtered.length < 2) {
    return { ok: true, points: [], total: 0, avgRate: 0, peakRate: 0,
      windowStart: cutoff, windowEnd: nowMs, resetTimes };
  }

  filtered.sort((a, b) => a.t - b.t);
  const deltas = computeDeltas(filtered);

  const numBuckets = Math.max(1, Math.floor(windowMs / rateBucketMs));
  const { total, avgRate, peakRate } = computeRateStats(deltas, cutoff, rateBucketMs, numBuckets);

  let points: BucketPoint[] | DataPoint[];
  let alignedStart = cutoff;

  if (bucketMs > 0) {
    alignedStart = alignToBucket(cutoff, bucketMs);
    points = bucketDeltas(deltas, alignedStart, nowMs, bucketMs, /* scalePartial */ true);
  } else if (deltas.length > maxPoints) {
    points = lttb(deltas, maxPoints);
  } else {
    points = deltas;
  }

  return {
    ok: true,
    points,
    total,
    avgRate,
    peakRate,
    windowStart: alignedStart,
    windowEnd: nowMs,
    resetTimes,
  };
}

/**
 * Compute bucketed usage history for a fixed calendar range.
 * Unlike computeHistory, partial-bucket scaling is NOT applied — historical
 * periods are complete, so raw sums are correct.
 *
 * @param entries      Pre-parsed HistoryEntry array
 * @param startMs      Range start in ms (inclusive)
 * @param endMs        Range end in ms (exclusive)
 * @param field        '5h' or '7d'
 * @param bucketMs     Bucket width in ms
 * @param rateBucketMs Bucket width for avg/peak rate computation
 */
export function computeHistoryRange(
  entries: HistoryEntry[],
  startMs: number,
  endMs: number,
  field: UsageField,
  bucketMs: number,
  rateBucketMs: number,
): HistoryResult | HistoryError {
  const filtered: DataPoint[] = [];

  for (const entry of entries) {
    const tMs = new Date(entry.ts).getTime();
    if (isNaN(tMs) || tMs < startMs || tMs > endMs) continue;

    const pct = entry[field];
    if (pct == null || typeof pct !== 'number') continue;

    const limits = getLimits(entry.tier);
    filtered.push({ t: tMs, v: (pct / 100) * limits[field] });
  }

  const resetTimes = extractResets(
    entries.filter((e) => {
      const tMs = new Date(e.ts).getTime();
      return !isNaN(tMs) && tMs >= startMs && tMs <= endMs;
    }),
    field,
  );

  if (filtered.length < 2) {
    return { ok: true, points: [], total: 0, avgRate: 0, peakRate: 0,
      windowStart: startMs, windowEnd: endMs, resetTimes };
  }

  filtered.sort((a, b) => a.t - b.t);
  const deltas = computeDeltas(filtered);

  const windowMs = endMs - startMs;
  const numBuckets = Math.max(1, Math.floor(windowMs / rateBucketMs));
  const { total, avgRate, peakRate } = computeRateStats(deltas, startMs, rateBucketMs, numBuckets);

  const points = bucketMs > 0
    ? bucketDeltas(deltas, startMs, endMs, bucketMs, /* scalePartial */ false)
    : [];

  return {
    ok: true,
    points,
    total,
    avgRate,
    peakRate,
    windowStart: startMs,
    windowEnd: endMs,
    resetTimes,
  };
}
