/**
 * cumulative.ts — shared accumulation helper (R1 anti-drift).
 *
 * Both the y-max precompute and the draw pass call walkCumulative with the
 * same pts + resetTimes, so they are guaranteed to produce identical segment
 * boundaries and credit sums — no drift is possible.
 */

import type { DataPoint, BucketPoint } from './historyReader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CumSeg {
  /** Left pixel edge of this segment (computed by caller, filled in callback). */
  bx: number;
  /** Width of this segment in pixels (computed by caller, filled in callback). */
  bw: number;
  /** Accumulated credit height in graph-height units (fraction of gh). */
  cumH: number;
  /** Index into pts[] of the bar that owns this segment. */
  barIdx: number;
}

/**
 * Per-bar geometry the caller must supply so walkCumulative can produce
 * pixel coordinates for each segment.
 */
export interface BarGeom {
  /** Full bar left-pixel edge. */
  fullBx: number;
  /** Full bar pixel width. */
  fullBw: number;
}

/**
 * Callback invoked once per rendered segment.
 * cumH is already clamped to [0, gh].
 */
export type SegmentCb = (seg: CumSeg) => void;

// ---------------------------------------------------------------------------
// Core walker
// ---------------------------------------------------------------------------

/**
 * Walk pts in order, accumulating credits within each rate-limit window.
 * Resets cumSum to 0 whenever a resetTime is crossed (indicator.js:313, 518).
 * When a reset falls inside a bar, splits proportionally by time
 * (indicator.js:339–354, 530–538).
 *
 * @param pts         Bar-level data points (BucketPoint preferred; dur required).
 * @param resetTimes  Sorted array of reset timestamps in ms.
 * @param wSpan       Window span in ms (used as dur fallback).
 * @param maxVal      Y-axis ceiling (credits); cumH is clamped to maxVal.
 * @param gh          Graph height in CSS pixels (used to convert credits → px).
 * @param geomFn      Returns BarGeom for pts[i] — called once per bar.
 * @param cb          Invoked once per produced CumSeg (may be called multiple
 *                    times per bar when mid-bar resets exist).
 * @returns cumMax    The maximum cumulative credit value seen (pre-clamping).
 */
export function walkCumulative(
  pts: Array<DataPoint | BucketPoint>,
  resetTimes: number[],
  wSpan: number,
  maxVal: number,
  gh: number,
  geomFn: (i: number) => BarGeom,
  cb: SegmentCb,
): number {
  let cumSum = 0;
  let rI = 0;
  let cumMax = 0;

  for (let i = 0; i < pts.length; i++) {
    // Advance past any resets that occurred at or before this bar's start
    // indicator.js:313 / 518
    while (rI < resetTimes.length && resetTimes[rI] <= pts[i].t) {
      cumSum = 0;
      rI++;
    }

    const barVal = Math.max(0, pts[i].v);
    const dur = ('dur' in pts[i] ? (pts[i] as BucketPoint).dur : 0) || wSpan / pts.length;
    const barStart = pts[i].t;
    const barEnd = barStart + dur;

    const { fullBx, fullBw } = geomFn(i);

    // Collect resets that fall strictly inside this bar
    // indicator.js:324–327 / 522–525
    const midResets: number[] = [];
    for (let ri = rI; ri < resetTimes.length && resetTimes[ri] < barEnd; ri++) {
      if (resetTimes[ri] > barStart) midResets.push(resetTimes[ri]);
    }

    if (midResets.length === 0) {
      // No mid-bar reset — single segment for the whole bar
      // indicator.js:328–333 / 526–528
      cumSum += barVal;
      if (cumSum > cumMax) cumMax = cumSum;
      const cumH = Math.min(cumSum, maxVal) / maxVal * gh;
      cb({ bx: fullBx, bw: fullBw, cumH, barIdx: i });
    } else {
      // Split bar into segments at each reset — indicator.js:334–355 / 529–538
      let segStart = barStart;
      for (let r = 0; r <= midResets.length; r++) {
        const segEnd = r < midResets.length ? midResets[r] : barEnd;
        const segFrac = (segEnd - segStart) / dur;
        const segCredits = barVal * segFrac;
        cumSum += segCredits;
        if (cumSum > cumMax) cumMax = cumSum;
        const cumH = Math.min(cumSum, maxVal) / maxVal * gh;

        const relStart = (segStart - barStart) / dur;
        const relEnd = (segEnd - barStart) / dur;
        const sbx = fullBx + relStart * fullBw;
        const sbw = Math.max(1, (relEnd - relStart) * fullBw);

        cb({ bx: sbx, bw: sbw, cumH, barIdx: i });

        if (r < midResets.length) {
          cumSum = 0;
          rI++;
        }
        segStart = segEnd;
      }
    }
  }

  return cumMax;
}

// ---------------------------------------------------------------------------
// Y-max precompute (no draw; returns raw cumMax for axis scaling)
// ---------------------------------------------------------------------------

/**
 * Compute cumMax without allocating segment arrays.
 * Mirrors indicator.js:514–542 exactly, using walkCumulative.
 */
export function computeCumMax(
  pts: Array<DataPoint | BucketPoint>,
  resetTimes: number[],
  wSpan: number,
): number {
  // maxVal and gh don't matter for cumMax — we use sentinel values that never
  // clamp (maxVal = Infinity, gh = 1 → cumH = cumSum / Infinity which is 0
  // but cumMax tracks pre-clamped cumSum so it's unaffected).
  // We pass gh=1 and maxVal=Infinity; cumH will always be 0 but cumMax is raw.
  return walkCumulative(
    pts,
    resetTimes,
    wSpan,
    Infinity,
    1,
    (i) => {
      const dur = ('dur' in pts[i] ? (pts[i] as BucketPoint).dur : 0) || wSpan / pts.length;
      // Pixel coords are irrelevant for max-precompute — pass zeroes.
      void dur;
      return { fullBx: 0, fullBw: 1 };
    },
    () => { /* no-op */ },
  );
}
