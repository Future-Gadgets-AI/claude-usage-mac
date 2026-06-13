import {
  getUsageRaw,
  getCredentialsMeta,
  getStatusRaw,
  parseUsage,
  classifyError,
} from './api.js';
import type { UsageSnapshot, CredentialsMeta, UsageState } from './api.js';
import { logUsage } from './usageLogger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefreshCallbacks {
  onUsage(state: UsageState, snapshot: UsageSnapshot | null, meta: CredentialsMeta | null): void;
  onStatus(raw: string): void;
  onTick(): void;
}

// ---------------------------------------------------------------------------
// RefreshController — pure logic + timers, no DOM
// ---------------------------------------------------------------------------

export class RefreshController {
  private readonly callbacks: RefreshCallbacks;

  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly USAGE_INTERVAL_MS = 300_000; // 5 min
  private static readonly STATUS_INTERVAL_MS = 120_000; // 2 min
  private static readonly TICK_INTERVAL_MS = 1_000;    // 1 s (popover open)

  constructor(callbacks: RefreshCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    // Immediate fetch on start
    void this.fetchUsage();
    void this.fetchStatus();

    this.usageTimer = setInterval(() => void this.fetchUsage(), RefreshController.USAGE_INTERVAL_MS);
    this.statusTimer = setInterval(() => void this.fetchStatus(), RefreshController.STATUS_INTERVAL_MS);
  }

  stop(): void {
    if (this.usageTimer !== null) { clearInterval(this.usageTimer); this.usageTimer = null; }
    if (this.statusTimer !== null) { clearInterval(this.statusTimer); this.statusTimer = null; }
    if (this.tickTimer !== null) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  /** Drive live countdown ticks while the popover is visible. */
  setPopoverOpen(open: boolean): void {
    if (open) {
      if (this.tickTimer === null) {
        this.tickTimer = setInterval(() => this.callbacks.onTick(), RefreshController.TICK_INTERVAL_MS);
      }
    } else {
      if (this.tickTimer !== null) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private fetch helpers
  // -------------------------------------------------------------------------

  private async fetchUsage(): Promise<void> {
    let raw: string;
    let meta: CredentialsMeta;

    try {
      [raw, meta] = await Promise.all([getUsageRaw(), getCredentialsMeta()]);
    } catch (err) {
      this.callbacks.onUsage(classifyError(err), null, null);
      return;
    }

    const result = parseUsage(raw);
    if (!result.ok) {
      this.callbacks.onUsage('network-error', null, null);
      return;
    }

    const { snapshot } = result;
    this.callbacks.onUsage('ok', snapshot, meta);

    // Fire-and-forget; logging failure must not crash the refresh cycle.
    logUsage(snapshot, meta).catch(() => undefined);
  }

  private async fetchStatus(): Promise<void> {
    try {
      const raw = await getStatusRaw();
      this.callbacks.onStatus(raw);
    } catch {
      // Status errors are non-critical; surface nothing — UI retains last value.
    }
  }
}
