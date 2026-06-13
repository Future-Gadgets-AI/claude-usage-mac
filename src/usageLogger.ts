import { appendLog, readLog } from './api.js';
import type { UsageSnapshot, CredentialsMeta } from './api.js';
import type { HistoryEntry } from './historyReader.js';

// ---------------------------------------------------------------------------
// buildLogEntry — API key → log key translation
// Key mapping rationale: historyReader.ts reads '5h', '7d', 'sonnet_7d', etc.
// The API returns 'five_hour', 'seven_day', etc. Translation happens here only.
// ---------------------------------------------------------------------------

export function buildLogEntry(snapshot: UsageSnapshot, meta: CredentialsMeta): HistoryEntry {
  const entry: HistoryEntry = {
    ts: new Date().toISOString(),
    plan: meta.plan ?? null,
    tier: meta.tier ?? null,
  };

  if (snapshot.fiveHour !== null) {
    entry['5h'] = snapshot.fiveHour.utilization;
    entry['5h_resets'] = snapshot.fiveHour.resetsAt;
  }

  if (snapshot.sevenDay !== null) {
    entry['7d'] = snapshot.sevenDay.utilization;
    entry['7d_resets'] = snapshot.sevenDay.resetsAt;
  }

  // Optional per-model fields: omit key entirely when window is null
  if (snapshot.sevenDaySonnet !== null) {
    entry['sonnet_7d'] = snapshot.sevenDaySonnet.utilization;
  }
  if (snapshot.sevenDayOpus !== null) {
    entry['opus_7d'] = snapshot.sevenDayOpus.utilization;
  }
  if (snapshot.sevenDayCowork !== null) {
    entry['cowork_7d'] = snapshot.sevenDayCowork.utilization;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Dedup state — only utilization values matter; reset timestamps are ignored.
// In-memory cache avoids a readLog() round-trip on every poll after init.
// ---------------------------------------------------------------------------

interface DedupValues {
  fiveHour: number | null;
  sevenDay: number | null;
  sonnet7d: number | null;
}

let _lastLogged: DedupValues | null = null;

function extractDedupValues(entry: HistoryEntry): DedupValues {
  return {
    fiveHour: typeof entry['5h'] === 'number' ? entry['5h'] : null,
    sevenDay: typeof entry['7d'] === 'number' ? entry['7d'] : null,
    sonnet7d: typeof entry['sonnet_7d'] === 'number' ? entry['sonnet_7d'] : null,
  };
}

function dedupEqual(a: DedupValues, b: DedupValues): boolean {
  return a.fiveHour === b.fiveHour && a.sevenDay === b.sevenDay && a.sonnet7d === b.sonnet7d;
}

/** Parse the last non-empty line from a JSONL blob without importing parseHistory. */
function lastDedupFromLog(jsonl: string): DedupValues | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        return extractDedupValues(parsed as HistoryEntry);
      }
    } catch {
      // malformed line — keep scanning upward
    }
    break; // only check the last line; don't scan further
  }
  return null;
}

// ---------------------------------------------------------------------------
// logUsage — serialize one JSON line, skip if utilization unchanged
// ---------------------------------------------------------------------------

export async function logUsage(snapshot: UsageSnapshot, meta: CredentialsMeta): Promise<void> {
  const entry = buildLogEntry(snapshot, meta);
  const incoming = extractDedupValues(entry);

  // On first call, seed cache from disk to survive process restarts.
  if (_lastLogged === null) {
    try {
      const raw = await readLog();
      _lastLogged = lastDedupFromLog(raw);
    } catch {
      _lastLogged = null;
    }
  }

  if (_lastLogged !== null && dedupEqual(_lastLogged, incoming)) {
    return; // utilization unchanged — skip
  }

  await appendLog(JSON.stringify(entry));
  _lastLogged = incoming;
}
