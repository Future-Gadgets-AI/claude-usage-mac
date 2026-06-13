/**
 * graph.ts — Canvas-based history graph renderer.
 * Faithful port of the Cairo draw function inside _createHistoryGraph /
 * _updateHistoryGraph in indicator.js (non-cumulative, non-navigation path).
 */

import type { HistoryResult } from './historyReader.js';
import { getLimits, formatCredits } from './historyReader.js';
import type { UsageField } from './historyReader.js';
import { walkCumulative } from './cumulative.js';
import type { CumSeg } from './cumulative.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphOpts {
  /** '5h' or '7d' — selects Pro 1x limit for gridlines. */
  field: UsageField;
  /** Label computation function: indicator.js lines 450–490. */
  labelFn: (wStart: number, wEnd: number) => Array<{ label: string; frac: number }>;
  /** Window period for boundary-line start computation (5h→18_000_000, 7d→604_800_000). */
  windowPeriodMs: number;
  /**
   * When true, draw cumulative green overlay behind blue bars.
   * The caller must supply cumMax (pre-computed via computeCumMax * 1.15)
   * so the y-axis auto-rescales; indicator.js:540–542.
   */
  showCumulative?: boolean;
  /** Pre-computed cumMax * 1.15 — required when showCumulative is true. */
  cumMax?: number;
}

// ---------------------------------------------------------------------------
// X-label helpers — direct port of indicator.js:440–490
// ---------------------------------------------------------------------------

function _formatHour(d: Date): string {
  // indicator.js:440–446
  const h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

// Exported so main.ts can pass them as opts.labelFn.
export function computeXLabels24h(
  wStart: number,
  wEnd: number,
): Array<{ label: string; frac: number }> {
  // indicator.js:450–472
  const span = wEnd - wStart || 1;
  const labels: Array<{ label: string; frac: number }> = [];
  const HOUR_LABELS = ['12am', '4am', '8am', '12pm', '4pm', '8pm'];
  const HOUR_VALUES = [0, 4, 8, 12, 16, 20];

  const d = new Date(wStart);
  d.setMinutes(0, 0, 0);
  const rem = d.getHours() % 4;
  if (rem !== 0) d.setHours(d.getHours() + (4 - rem));

  while (d.getTime() <= wEnd) {
    const frac = (d.getTime() - wStart) / span;
    if (frac >= 0 && frac <= 1) {
      const idx = HOUR_VALUES.indexOf(d.getHours());
      if (idx !== -1) {
        labels.push({ label: HOUR_LABELS[idx], frac });
      }
    }
    d.setHours(d.getHours() + 4);
  }
  return labels;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function computeXLabels7d(
  wStart: number,
  wEnd: number,
): Array<{ label: string; frac: number }> {
  // indicator.js:474–490
  const span = wEnd - wStart || 1;
  const labels: Array<{ label: string; frac: number }> = [];

  const d = new Date(wStart);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);

  while (d.getTime() <= wEnd) {
    const frac = (d.getTime() - wStart) / span;
    if (frac >= 0 && frac <= 1) {
      labels.push({ label: DAY_NAMES[d.getDay()], frac });
    }
    d.setDate(d.getDate() + 1);
  }
  return labels;
}

// Keep _formatHour available (satisfies noUnusedLocals via the export path
// through computeXLabels24h — unused here but referenced for completeness).
void _formatHour;

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render one history graph onto a canvas element.
 * Consumes a HistoryResult from computeHistory — does NOT rebucket.
 *
 * Padding layout matches indicator.js line 218:
 *   left:36  right:8  top:8  bottom:16
 */
export function renderGraph(
  canvas: HTMLCanvasElement,
  result: HistoryResult,
  opts: GraphOpts,
): void {
  // ── HiDPI scaling ─────────────────────────────────────────────────────────
  // Set backing store to CSS pixels × devicePixelRatio, then scale context
  // so all drawing uses CSS-pixel coordinates. Prevents blurry canvas on
  // Retina / high-DPI displays.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const w = cssW;
  const h = cssH;

  // ── Padding — indicator.js:218 ────────────────────────────────────────────
  const pad = { left: 36, right: 8, top: 8, bottom: 16 };
  const gw = w - pad.left - pad.right;
  const gh = h - pad.top - pad.bottom;

  // ── Background — indicator.js:226-228: _roundedRect + #2a2a2a fill ────────
  ctx.clearRect(0, 0, w, h);
  // The .graph-canvas-wrap already has background:#2a2a2a and border-radius:6px
  // in CSS, so we skip the rounded-rect fill here to avoid double-drawing.

  const pts = result.points;
  const noData = pts.length === 0;

  // maxVal — indicator.js:540–542:
  //   minMax = unitCredits > 0 ? unitCredits * 1.15 : 0
  //   maxVal = max(pointMax > 0 ? pointMax * 1.15 : 1, minMax)
  //   In cumulative mode, also factor in cumMax so green bars never overflow.
  const unitCredits = getLimits(null)[opts.field]; // PRO_1X_LIMITS[field]
  let pointMax = 0;
  for (const p of pts) { if (p.v > pointMax) pointMax = p.v; }
  const minMax = unitCredits > 0 ? unitCredits * 1.15 : 0;
  let maxVal = Math.max(pointMax > 0 ? pointMax * 1.15 : 1, minMax);
  if (opts.showCumulative && opts.cumMax && opts.cumMax > maxVal) {
    maxVal = opts.cumMax;
  }

  // ── Gridlines + Y-axis labels — indicator.js:231–268 ─────────────────────
  ctx.font = '9px sans-serif';

  if (unitCredits > 0) {
    // 1x-based gridlines: step doubles while (unitCredits * step * 5 < maxVal)
    // indicator.js:234–235
    let step = 1;
    while (unitCredits * step * 5 < maxVal) step *= 2;

    for (let m = step; m * unitCredits <= maxVal; m += step) {
      const frac = (m * unitCredits) / maxVal;
      const gy = pad.top + gh * (1 - frac);

      // Gridline — indicator.js:241–243: rgba(1,1,1,0.08)
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + gw, gy);
      ctx.stroke();

      // Y label — indicator.js:245–247: rgba(1,1,1,0.35), moveTo(2, gy+3)
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(`${m}x`, 2, gy + 3);
    }
  } else {
    // Fallback fixed 25/50/75/100% gridlines — indicator.js:250–267
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75, 1.0]) {
      const gy = pad.top + gh * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + gw, gy);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    const halfLabel = formatCredits(maxVal * 0.5);
    const fullLabel = formatCredits(maxVal);
    for (const [frac, label] of [[0.5, halfLabel], [1.0, fullLabel]] as [number, string][]) {
      const gy = pad.top + gh * (1 - frac);
      ctx.fillText(label, 2, gy + 3);
    }
  }

  // ── X-axis labels — indicator.js:271–284 ─────────────────────────────────
  const xLabels = opts.labelFn(result.windowStart, result.windowEnd);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px sans-serif';
  for (const item of xLabels) {
    const lx = pad.left + item.frac * gw;
    const tw = ctx.measureText(item.label).width;
    let tx = lx - tw / 2;
    tx = Math.max(pad.left, Math.min(pad.left + gw - tw, tx));
    // indicator.js:283: moveTo(tx, h-2) — bottom of graph area
    ctx.fillText(item.label, tx, h - 2);
  }

  // ── No data path — indicator.js:287–297 ──────────────────────────────────
  if (noData) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '12px sans-serif';
    const txt = 'No data';
    const tw = ctx.measureText(txt).width;
    // indicator.js:293: moveTo(w/2 - ext.width/2, h/2 + ext.height/2)
    // Canvas fillText baseline is alphabetic; approximate ext.height with 10px.
    ctx.fillText(txt, w / 2 - tw / 2, h / 2 + 5);
    return;
  }

  // ── Bar geometry shared state ─────────────────────────────────────────────
  const wStart = result.windowStart;
  const wEnd = result.windowEnd;
  const wSpan = wEnd - wStart || 1;
  const barGap = 1;       // indicator.js:303
  const baseline = pad.top + gh; // indicator.js:304

  // ── Green cumulative overlay — indicator.js:306–357 ──────────────────────
  // cumSegs stored for the dotted-line pass — indicator.js:412–432
  const cumSegs: CumSeg[] = [];
  if (opts.showCumulative && pts.length > 0) {
    ctx.fillStyle = 'rgba(51,179,77,1)'; // indicator.js:311: rgba(0.2,0.7,0.3,1)
    walkCumulative(
      pts,
      result.resetTimes,
      wSpan,
      maxVal,
      gh,
      (i) => {
        const p = pts[i];
        const dur = 'dur' in p ? (p as { dur: number }).dur : wSpan / pts.length;
        const frac = (p.t - wStart) / wSpan;
        const fracW = dur / wSpan;
        const fullBx = pad.left + frac * gw + barGap / 2;
        const fullBw = Math.max(1, fracW * gw - barGap);
        return { fullBx, fullBw };
      },
      (seg) => {
        cumSegs.push(seg);
        // indicator.js:347: draw only if cumH > 0.5
        if (seg.cumH > 0.5) {
          ctx.fillRect(seg.bx, baseline - seg.cumH, seg.bw, seg.cumH);
        }
      },
    );
  }

  // ── Blue bars — indicator.js:299–378 ─────────────────────────────────────
  for (const pt of pts) {
    const v = Math.min(maxVal, Math.max(0, pt.v));
    const barH = (v / maxVal) * gh;
    // indicator.js:362–366
    const dur = 'dur' in pt ? (pt as { dur: number }).dur : wSpan / pts.length;
    const frac = (pt.t - wStart) / wSpan;
    const fracW = dur / wSpan;
    const bx = pad.left + frac * gw + barGap / 2;
    const bw = Math.max(1, fracW * gw - barGap);

    // Bar fill — indicator.js:369–371: rgba(0.21,0.52,0.89,1)
    ctx.fillStyle = 'rgba(54,133,228,1)'; // #3685e4 ≈ rgb(0.21,0.52,0.89)
    ctx.fillRect(bx, baseline - barH, bw, barH);

    // Bar top edge — indicator.js:373–376
    if (barH > 0) {
      ctx.fillStyle = 'rgba(54,133,228,0.9)';
      ctx.fillRect(bx, baseline - barH, bw, 1);
    }
  }

  // ── Boundary lines — indicator.js:382–409 ────────────────────────────────
  const rTimes = result.resetTimes;
  const wPeriod = opts.windowPeriodMs;

  if (rTimes.length > 0 && wPeriod > 0) {
    const resetMs = new Set(rTimes);
    const startMs = new Set(rTimes.map((t) => t - wPeriod));
    const allTimes = new Set([...resetMs, ...startMs]);

    ctx.lineWidth = 1;
    for (const t of allTimes) {
      const f = (t - wStart) / wSpan;
      if (f <= 0 || f >= 1) continue;
      const lx = pad.left + f * gw;

      const isReset = resetMs.has(t);
      const isStart = startMs.has(t);

      // Near-match check (within 60 000 ms) — indicator.js:397–398
      const nearReset = isReset || [...resetMs].some((r) => Math.abs(r - t) <= 60_000);
      const nearStart = isStart || [...startMs].some((s) => Math.abs(s - t) <= 60_000);

      if (nearReset && nearStart) {
        // Purple — indicator.js:400: rgba(0.55,0.25,0.85,0.35)
        ctx.strokeStyle = 'rgba(140,64,217,0.35)';
      } else if (nearReset) {
        // Red — indicator.js:402: rgba(1,0.3,0.3,0.25)
        ctx.strokeStyle = 'rgba(255,77,77,0.25)';
      } else {
        // Blue — indicator.js:404: rgba(0.3,0.5,1,0.25)
        ctx.strokeStyle = 'rgba(77,128,255,0.25)';
      }

      ctx.beginPath();
      ctx.moveTo(lx, pad.top);
      ctx.lineTo(lx, pad.top + gh);
      ctx.stroke();
    }
  }

  // ── Dotted green line where cumulative is obscured by blue — indicator.js:411–432 ──
  if (cumSegs.length > 0) {
    let dashSet = false;
    for (const seg of cumSegs) {
      const pt = pts[seg.barIdx];
      const barV = Math.min(maxVal, Math.max(0, pt.v));
      const barH = (barV / maxVal) * gh;
      // indicator.js:418: seg.cumH > 3 && seg.cumH <= barH + 1
      if (seg.cumH > 3 && seg.cumH <= barH + 1) {
        if (!dashSet) {
          ctx.strokeStyle = 'rgba(51,179,77,0.9)'; // indicator.js:420: rgba(0.2,0.7,0.3,0.9)
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 3]); // indicator.js:421: setDash([3,3], 0)
          dashSet = true;
        }
        const ly = baseline - seg.cumH;
        ctx.beginPath();
        ctx.moveTo(seg.bx, ly);
        ctx.lineTo(seg.bx + seg.bw, ly);
        ctx.stroke();
      }
    }
    if (dashSet) ctx.setLineDash([]); // indicator.js:431: setDash([], 0)
  }
}
