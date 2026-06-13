import { invoke } from '@tauri-apps/api/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Window {
  utilization: number;
  resetsAt: string;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface UsageSnapshot {
  fiveHour: Window | null;
  sevenDay: Window | null;
  sevenDaySonnet: Window | null;
  sevenDayOpus: Window | null;
  sevenDayCowork: Window | null;
  extraUsage: ExtraUsage | null;
}

export interface CredentialsMeta {
  plan: string | null;
  tier: string | null;
  expiresAt: number | null;
}

/** What the UI switches on after a fetch attempt. */
export type UsageState = 'ok' | 'no-credentials' | 'reauth-needed' | 'network-error';

// ---------------------------------------------------------------------------
// Invoke wrappers
// ---------------------------------------------------------------------------

export async function getUsageRaw(): Promise<string> {
  return invoke<string>('get_usage');
}

export async function getCredentialsMeta(): Promise<CredentialsMeta> {
  return invoke<CredentialsMeta>('get_credentials_meta');
}

export async function getStatusRaw(): Promise<string> {
  return invoke<string>('get_status');
}

export async function appendLog(line: string): Promise<void> {
  return invoke<void>('append_log', { line });
}

export async function readLog(): Promise<string> {
  return invoke<string>('read_log');
}

// ---------------------------------------------------------------------------
// Defensive parser helpers
// ---------------------------------------------------------------------------

function toWindow(obj: unknown): Window | null {
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const utilization = typeof o['utilization'] === 'number' ? o['utilization'] : null;
  const resetsAt = typeof o['resets_at'] === 'string' ? o['resets_at'] : null;
  if (utilization === null || resetsAt === null) return null;
  return { utilization, resetsAt };
}

function toExtraUsage(obj: unknown): ExtraUsage | null {
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  return {
    isEnabled: typeof o['is_enabled'] === 'boolean' ? o['is_enabled'] : false,
    monthlyLimit: typeof o['monthly_limit'] === 'number' ? o['monthly_limit'] : null,
    usedCredits: typeof o['used_credits'] === 'number' ? o['used_credits'] : null,
    utilization: typeof o['utilization'] === 'number' ? o['utilization'] : null,
    currency: typeof o['currency'] === 'string' ? o['currency'] : null,
  };
}

// ---------------------------------------------------------------------------
// parseUsage — NEVER throws; unknown/null sub-objects → that window is null
// ---------------------------------------------------------------------------

export function parseUsage(raw: string): { ok: true; snapshot: UsageSnapshot } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: 'unexpected root type' };
  }

  const o = parsed as Record<string, unknown>;

  const snapshot: UsageSnapshot = {
    fiveHour: toWindow(o['five_hour'] ?? null),
    sevenDay: toWindow(o['seven_day'] ?? null),
    sevenDaySonnet: toWindow(o['seven_day_sonnet'] ?? null),
    sevenDayOpus: toWindow(o['seven_day_opus'] ?? null),
    sevenDayCowork: toWindow(o['seven_day_cowork'] ?? null),
    extraUsage: toExtraUsage(o['extra_usage'] ?? null),
  };

  return { ok: true, snapshot };
}

// ---------------------------------------------------------------------------
// Error string → UsageState
// ---------------------------------------------------------------------------

export function classifyError(err: unknown): UsageState {
  const msg = typeof err === 'string' ? err : String(err);
  if (msg === 'no-credentials') return 'no-credentials';
  if (msg === 'reauth-needed') return 'reauth-needed';
  return 'network-error';
}
