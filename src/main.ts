import { RefreshController } from './refresh.js';
import type { UsageSnapshot, CredentialsMeta, UsageState } from './api.js';
import { readLog } from './api.js';
import { formatCountdown, timeMarkerFraction, getBarColorClass } from './format.js';
import { parseHistory, computeHistory, computeHistoryRange, formatCredits } from './historyReader.js';
import type { HistoryEntry } from './historyReader.js';
import { renderGraph, computeXLabels24h, computeXLabels7d } from './graph.js';
import { computeCumMax } from './cumulative.js';

// ---------------------------------------------------------------------------
// Window durations — indicator.js:17-18
// ---------------------------------------------------------------------------
const FIVE_HOUR_S = 5 * 3600;     // 18000
const SEVEN_DAY_S = 7 * 24 * 3600; // 604800

// ---------------------------------------------------------------------------
// Graph parameters — indicator.js:1362, 1381
// ---------------------------------------------------------------------------
const GRAPH_MAX_POINTS = 200;
const BUCKET_5H_MS   = 30 * 60 * 1000;       // 30 min
const RATE_BUCKET_5H = 60 * 60 * 1000;        // 1 hr
const WINDOW_5H_MS   = 24 * 60 * 60 * 1000;   // 24h rolling
const WINDOW_PERIOD_5H = 5 * 60 * 60 * 1000;  // 5h (for boundary lines)

const BUCKET_7D_MS   = 24 * 60 * 60 * 1000;   // 1 day
const RATE_BUCKET_7D = 24 * 60 * 60 * 1000;   // 1 day
const WINDOW_7D_MS   = 7 * 24 * 60 * 60 * 1000; // 7d rolling
const WINDOW_PERIOD_7D = 7 * 24 * 60 * 60 * 1000; // 7d (for boundary lines)

// ---------------------------------------------------------------------------
// Navigation + cumulative state
// ---------------------------------------------------------------------------

/** Cumulative-mode toggle — applies to both graphs. */
let _showCumulative = false;

/** Per-graph day/week offset (0 = current rolling window). */
let _offset5h = 0; // day offset
let _offset7d = 0; // week offset

/** Cached raw log entries so navigation can re-bucket without re-fetching. */
let _entries: HistoryEntry[] = [];

// Calendar-name helpers — mirror indicator.js:554, 562–593
const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_NAMES_NAV     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/**
 * Compute a calendar-aligned range for navigation.
 * offset=0 → null (rolling window).
 * indicator.js:562–593
 */
function computeTimeRange(
  type: 'day' | 'week',
  offset: number,
): { startMs: number; endMs: number; label: string } | null {
  if (offset === 0) return null;

  const now = new Date();

  if (type === 'day') {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(today.getTime() - (offset - 1) * 86_400_000);
    const startDate = new Date(endDate.getTime() - 86_400_000);
    const d = startDate;
    const label = `${DAY_NAMES_NAV[d.getDay()]} ${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}`;
    return { startMs: startDate.getTime(), endMs: endDate.getTime(), label };
  }

  // type === 'week'
  const thisSunday = new Date(now);
  thisSunday.setHours(0, 0, 0, 0);
  thisSunday.setDate(thisSunday.getDate() - thisSunday.getDay());
  const endDate = new Date(thisSunday.getTime() - (offset - 1) * 7 * 86_400_000);
  const startDate = new Date(endDate.getTime() - 7 * 86_400_000);
  const s = startDate;
  const e = new Date(endDate.getTime() - 86_400_000); // Saturday
  const label = `${MONTH_NAMES_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTH_NAMES_SHORT[e.getMonth()]} ${e.getDate()}`;
  return { startMs: startDate.getTime(), endMs: endDate.getTime(), label };
}

// ---------------------------------------------------------------------------
// Cached state for countdowns
// ---------------------------------------------------------------------------
let _snapshot: UsageSnapshot | null = null;
let _lastFetchMs = 0;

// ---------------------------------------------------------------------------
// DOM refs — queried once at DOMContentLoaded
// ---------------------------------------------------------------------------
let errorBanner!: HTMLElement;
let headerDot!: HTMLElement;

let barFill5h!: HTMLElement;
let barMarker5h!: HTMLElement;
let pct5h!: HTMLElement;
let reset5h!: HTMLElement;

let barFill7d!: HTMLElement;
let barMarker7d!: HTMLElement;
let pct7d!: HTMLElement;
let reset7d!: HTMLElement;

let modelSection!: HTMLElement;
let rowSonnet!: HTMLElement;
let rowOpus!: HTMLElement;
let rowCowork!: HTMLElement;
let pctSonnet!: HTMLElement;
let pctOpus!: HTMLElement;
let pctCowork!: HTMLElement;

let dotClaudeAI!: HTMLElement;
let dotAPI!: HTMLElement;
let dotClaudeCode!: HTMLElement;
let statusClaudeAI!: HTMLElement;
let statusAPI!: HTMLElement;
let statusClaudeCode!: HTMLElement;
let incidentLabel!: HTMLElement;

let btnRefresh!: HTMLButtonElement;
let lastUpdated!: HTMLElement;

let canvas5h!: HTMLCanvasElement;
let canvas7d!: HTMLCanvasElement;
let stats5h!: HTMLElement;
let stats7d!: HTMLElement;

let btnSigma!: HTMLButtonElement;
let btn5hPrev!: HTMLButtonElement;
let btn5hNext!: HTMLButtonElement;
let btn7dPrev!: HTMLButtonElement;
let btn7dNext!: HTMLButtonElement;
let navLabel5h!: HTMLElement;
let navLabel7d!: HTMLElement;

// ---------------------------------------------------------------------------
// Bar helpers — CSS/DOM port of _createDropdownBar / _updateDropdownBar
// ---------------------------------------------------------------------------

function updateBar(
  fill: HTMLElement,
  marker: HTMLElement,
  pct: number,
  markerFraction: number
): void {
  // Fill width as percentage of track
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;

  // Threshold color — indicator.js:182-183
  const colorClass = getBarColorClass(pct);
  fill.className = `bar-fill ${colorClass}`;

  // White time-position marker — indicator.js:185-191
  // markerFraction > 0 and < 1 → visible; outside → hidden
  if (markerFraction > 0 && markerFraction < 1) {
    marker.style.left = `${markerFraction * 100}%`;
    marker.classList.add('visible');
  } else {
    marker.classList.remove('visible');
  }
}

// ---------------------------------------------------------------------------
// Countdown re-render (onTick — called every 1s)
// ---------------------------------------------------------------------------

function renderCountdowns(): void {
  if (!_snapshot) return;

  const fh = _snapshot.fiveHour;
  const sd = _snapshot.sevenDay;

  reset5h.textContent = fh ? formatCountdown(fh.resetsAt) : '';
  reset7d.textContent = sd ? formatCountdown(sd.resetsAt) : '';

  // Re-render markers (position drifts as time advances)
  if (fh) {
    const m = timeMarkerFraction(fh.resetsAt, FIVE_HOUR_S);
    if (m > 0 && m < 1) {
      barMarker5h.style.left = `${m * 100}%`;
      barMarker5h.classList.add('visible');
    } else {
      barMarker5h.classList.remove('visible');
    }
  }
  if (sd) {
    const m = timeMarkerFraction(sd.resetsAt, SEVEN_DAY_S);
    if (m > 0 && m < 1) {
      barMarker7d.style.left = `${m * 100}%`;
      barMarker7d.classList.add('visible');
    } else {
      barMarker7d.classList.remove('visible');
    }
  }
}

// ---------------------------------------------------------------------------
// renderGraphs — reads log (or reuses cached entries), paints both canvases.
// Called after each usage poll, on resize, and on navigation/sigma events.
// ---------------------------------------------------------------------------

/**
 * Render one graph canvas.
 * Uses computeHistoryRange when offset > 0, otherwise computeHistory (rolling).
 */
function renderOneGraph(
  canvas: HTMLCanvasElement,
  statsEl: HTMLElement,
  navLabelEl: HTMLElement,
  nextBtn: HTMLButtonElement,
  entries: HistoryEntry[],
  nowMs: number,
  graphType: 'day' | 'week',
  field: '5h' | '7d',
  windowMs: number,
  bucketMs: number,
  rateBucketMs: number,
  windowPeriodMs: number,
  labelFn: (wStart: number, wEnd: number) => Array<{ label: string; frac: number }>,
  rateUnit: string,
  offset: number,
): void {
  // Determine range and update nav label / next-button state
  const range = computeTimeRange(graphType, offset);

  if (offset === 0) {
    navLabelEl.textContent = graphType === 'day' ? 'Today' : 'This week';
    nextBtn.disabled = true;
    nextBtn.style.opacity = '0.25';
  } else {
    navLabelEl.textContent = range!.label;
    nextBtn.disabled = false;
    nextBtn.style.opacity = '';
  }

  const fallbackResult = {
    ok: true as const,
    points: [],
    total: 0,
    avgRate: 0,
    peakRate: 0,
    windowStart: range ? range.startMs : nowMs - windowMs,
    windowEnd:   range ? range.endMs   : nowMs,
    resetTimes: [],
  };

  const rawResult = range
    ? computeHistoryRange(entries, range.startMs, range.endMs, field, bucketMs, rateBucketMs)
    : computeHistory(entries, nowMs, windowMs, field, GRAPH_MAX_POINTS, bucketMs, rateBucketMs);

  const result = rawResult.ok ? rawResult : fallbackResult;

  // Compute cumMax for y-axis scaling when cumulative mode is on
  let cumMax: number | undefined;
  if (_showCumulative && result.points.length > 0) {
    const wSpan = result.windowEnd - result.windowStart || 1;
    const raw = computeCumMax(result.points, result.resetTimes, wSpan);
    cumMax = raw > 0 ? raw * 1.15 : undefined;
  }

  renderGraph(canvas, result, {
    field,
    labelFn,
    windowPeriodMs,
    showCumulative: _showCumulative,
    cumMax,
  });

  if (result.points.length > 0) {
    statsEl.textContent =
      `avg ${formatCredits(result.avgRate)}/${rateUnit}  |  peak ${formatCredits(result.peakRate)}/${rateUnit}  |  total ${formatCredits(result.total)}`;
  } else {
    statsEl.textContent = 'No data';
  }
}

async function renderGraphs(): Promise<void> {
  let raw: string;
  try {
    raw = await readLog();
  } catch {
    return;
  }

  _entries = parseHistory(raw);
  renderGraphsFromCache();
}

function renderGraphsFromCache(): void {
  const nowMs = Date.now();
  const entries = _entries;

  renderOneGraph(
    canvas5h, stats5h, navLabel5h, btn5hNext,
    entries, nowMs, 'day', '5h',
    WINDOW_5H_MS, BUCKET_5H_MS, RATE_BUCKET_5H, WINDOW_PERIOD_5H,
    computeXLabels24h, 'hr', _offset5h,
  );

  renderOneGraph(
    canvas7d, stats7d, navLabel7d, btn7dNext,
    entries, nowMs, 'week', '7d',
    WINDOW_7D_MS, BUCKET_7D_MS, RATE_BUCKET_7D, WINDOW_PERIOD_7D,
    computeXLabels7d, 'day', _offset7d,
  );
}

// ---------------------------------------------------------------------------
// onUsage
// ---------------------------------------------------------------------------

function onUsage(
  state: UsageState,
  snapshot: UsageSnapshot | null,
  _meta: CredentialsMeta | null
): void {
  if (state !== 'ok') {
    errorBanner.classList.add('visible');
    errorBanner.textContent = errorMessage(state);
    return;
  }

  errorBanner.classList.remove('visible');

  if (!snapshot) return;
  _snapshot = snapshot;
  _lastFetchMs = Date.now();

  // ── 5h bar ──────────────────────────────────────────────────────────────
  const fh = snapshot.fiveHour;
  if (fh) {
    const p5 = Math.round(fh.utilization);
    const m5 = timeMarkerFraction(fh.resetsAt, FIVE_HOUR_S);
    updateBar(barFill5h, barMarker5h, p5, m5);
    pct5h.textContent = `${p5}%`;
    reset5h.textContent = formatCountdown(fh.resetsAt);
  } else {
    updateBar(barFill5h, barMarker5h, 0, 0);
    pct5h.textContent = '--%';
    reset5h.textContent = '';
  }

  // ── 7d bar ──────────────────────────────────────────────────────────────
  const sd = snapshot.sevenDay;
  if (sd) {
    const p7 = Math.round(sd.utilization);
    const m7 = timeMarkerFraction(sd.resetsAt, SEVEN_DAY_S);
    updateBar(barFill7d, barMarker7d, p7, m7);
    pct7d.textContent = `${p7}%`;
    reset7d.textContent = formatCountdown(sd.resetsAt);
  } else {
    updateBar(barFill7d, barMarker7d, 0, 0);
    pct7d.textContent = '--%';
    reset7d.textContent = '';
  }

  // ── Per-model rows — only shown when window is non-null ─────────────────
  let anyModel = false;

  if (snapshot.sevenDaySonnet !== null) {
    pctSonnet.textContent = `${Math.round(snapshot.sevenDaySonnet.utilization)}%`;
    rowSonnet.classList.add('visible');
    anyModel = true;
  } else {
    rowSonnet.classList.remove('visible');
  }

  if (snapshot.sevenDayOpus !== null) {
    pctOpus.textContent = `${Math.round(snapshot.sevenDayOpus.utilization)}%`;
    rowOpus.classList.add('visible');
    anyModel = true;
  } else {
    rowOpus.classList.remove('visible');
  }

  if (snapshot.sevenDayCowork !== null) {
    pctCowork.textContent = `${Math.round(snapshot.sevenDayCowork.utilization)}%`;
    rowCowork.classList.add('visible');
    anyModel = true;
  } else {
    rowCowork.classList.remove('visible');
  }

  modelSection.classList.toggle('visible', anyModel);

  // ── Last updated ─────────────────────────────────────────────────────────
  renderLastUpdated();

  // ── History graphs — re-render after each successful usage poll ───────────
  void renderGraphs();
}

// ---------------------------------------------------------------------------
// onStatus — defensive parse of status.claude.com summary JSON
// ---------------------------------------------------------------------------

interface StatusComponent {
  name: string;
  status: string;
}

interface StatusSummary {
  status?: { indicator?: string };
  components?: StatusComponent[];
  incidents?: Array<{ name: string; status: string }>;
}

function dotClass(indicator: string): string {
  if (indicator === 'critical' || indicator === 'major') return 'dot-critical';
  if (indicator === 'minor') return 'dot-minor';
  if (indicator === 'maintenance') return 'dot-degraded';
  return 'dot-operational';
}

function componentDotClass(status: string): string {
  if (status === 'major_outage') return 'dot-critical';
  if (status === 'partial_outage') return 'dot-minor';
  if (status === 'degraded_performance' || status === 'under_maintenance') return 'dot-degraded';
  return 'dot-operational';
}

function applyDotClass(el: HTMLElement, cls: string): void {
  el.className = `component-dot ${cls}`;
}

function onStatus(raw: string): void {
  let data: StatusSummary;
  try {
    data = JSON.parse(raw) as StatusSummary;
  } catch {
    return; // malformed — retain previous state
  }

  // Overall header dot
  const overallIndicator = data.status?.indicator ?? 'none';
  headerDot.className = `component-dot ${dotClass(overallIndicator)}`;

  // Component rows — matched by display name / API name
  const COMPONENT_MAP: Record<string, { dot: HTMLElement; status: HTMLElement }> = {
    'claude.ai':                       { dot: dotClaudeAI,    status: statusClaudeAI },
    'Claude API (api.anthropic.com)':  { dot: dotAPI,         status: statusAPI },
    'Claude Code':                     { dot: dotClaudeCode,  status: statusClaudeCode },
  };

  const components = data.components ?? [];
  for (const comp of components) {
    const mapping = COMPONENT_MAP[comp.name];
    if (!mapping) continue;
    const text = comp.status.replace(/_/g, ' ');
    mapping.status.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    applyDotClass(mapping.dot, componentDotClass(comp.status));
  }

  // Incidents
  const incidents = data.incidents ?? [];
  if (incidents.length > 0) {
    incidentLabel.textContent = incidents.map(i => `${i.name} (${i.status})`).join('\n');
    incidentLabel.classList.add('visible');
  } else {
    incidentLabel.classList.remove('visible');
  }
}

// ---------------------------------------------------------------------------
// onTick — re-render countdown labels every 1s
// ---------------------------------------------------------------------------

function onTick(): void {
  renderCountdowns();
  renderLastUpdated();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(state: UsageState): string {
  switch (state) {
    case 'no-credentials':  return 'Open Claude Code and sign in';
    case 'reauth-needed':   return 'Reopen Claude Code to re-authenticate';
    case 'network-error':   return "Can't reach Anthropic — retrying…";
    default:                return 'Unknown error';
  }
}

function renderLastUpdated(): void {
  if (_lastFetchMs === 0) {
    lastUpdated.textContent = '';
    return;
  }
  const agoS = Math.round((Date.now() - _lastFetchMs) / 1000);
  lastUpdated.textContent = `Updated ${agoS}s ago`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  errorBanner     = document.getElementById('error-banner')!;
  headerDot       = document.getElementById('header-status-dot')!;

  barFill5h       = document.getElementById('bar-fill-5h')!;
  barMarker5h     = document.getElementById('bar-marker-5h')!;
  pct5h           = document.getElementById('pct-5h')!;
  reset5h         = document.getElementById('reset-5h')!;

  barFill7d       = document.getElementById('bar-fill-7d')!;
  barMarker7d     = document.getElementById('bar-marker-7d')!;
  pct7d           = document.getElementById('pct-7d')!;
  reset7d         = document.getElementById('reset-7d')!;

  modelSection    = document.getElementById('model-section')!;
  rowSonnet       = document.getElementById('row-sonnet')!;
  rowOpus         = document.getElementById('row-opus')!;
  rowCowork       = document.getElementById('row-cowork')!;
  pctSonnet       = document.getElementById('pct-sonnet')!;
  pctOpus         = document.getElementById('pct-opus')!;
  pctCowork       = document.getElementById('pct-cowork')!;

  dotClaudeAI     = document.getElementById('dot-claudeai')!;
  dotAPI          = document.getElementById('dot-api')!;
  dotClaudeCode   = document.getElementById('dot-claudecode')!;
  statusClaudeAI  = document.getElementById('status-claudeai')!;
  statusAPI       = document.getElementById('status-api')!;
  statusClaudeCode = document.getElementById('status-claudecode')!;
  incidentLabel   = document.getElementById('incident-label')!;

  btnRefresh      = document.getElementById('btn-refresh') as HTMLButtonElement;
  lastUpdated     = document.getElementById('last-updated')!;

  canvas5h        = document.getElementById('canvas-5h') as HTMLCanvasElement;
  canvas7d        = document.getElementById('canvas-7d') as HTMLCanvasElement;
  stats5h         = document.getElementById('stats-5h')!;
  stats7d         = document.getElementById('stats-7d')!;

  btnSigma    = document.getElementById('btn-sigma') as HTMLButtonElement;
  btn5hPrev   = document.getElementById('btn-5h-prev') as HTMLButtonElement;
  btn5hNext   = document.getElementById('btn-5h-next') as HTMLButtonElement;
  btn7dPrev   = document.getElementById('btn-7d-prev') as HTMLButtonElement;
  btn7dNext   = document.getElementById('btn-7d-next') as HTMLButtonElement;
  navLabel5h  = document.getElementById('nav-label-5h')!;
  navLabel7d  = document.getElementById('nav-label-7d')!;

  // Σ toggle — cumulative mode on both graphs
  btnSigma.addEventListener('click', () => {
    _showCumulative = !_showCumulative;
    btnSigma.classList.toggle('active', _showCumulative);
    renderGraphsFromCache();
  });

  // 5h graph navigation (day offsets — indicator.js:595 _updateHistoryGraphRange)
  btn5hPrev.addEventListener('click', () => {
    _offset5h++;
    renderGraphsFromCache();
  });
  btn5hNext.addEventListener('click', () => {
    if (_offset5h > 0) { _offset5h--; renderGraphsFromCache(); }
  });

  // 7d graph navigation (week offsets)
  btn7dPrev.addEventListener('click', () => {
    _offset7d++;
    renderGraphsFromCache();
  });
  btn7dNext.addEventListener('click', () => {
    if (_offset7d > 0) { _offset7d--; renderGraphsFromCache(); }
  });

  // Re-render graphs on window resize so HiDPI backing store stays correct.
  window.addEventListener('resize', () => { renderGraphsFromCache(); });

  const ctrl = new RefreshController({ onUsage, onStatus, onTick });

  // Offset reset when popover hides — indicator.js:_updateHistoryGraphRange
  const origSetPopoverOpen = ctrl.setPopoverOpen.bind(ctrl);
  ctrl.setPopoverOpen = (open: boolean) => {
    if (!open) {
      _offset5h = 0;
      _offset7d = 0;
    }
    origSetPopoverOpen(open);
  };

  ctrl.start();

  // Always-open dev mode; Phase 7 gates this on tray visibility.
  ctrl.setPopoverOpen(true);

  btnRefresh.addEventListener('click', () => {
    ctrl.stop();
    ctrl.start();
  });
});
