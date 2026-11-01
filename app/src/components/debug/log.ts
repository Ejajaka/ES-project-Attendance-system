/**
 * Tiny in-app debug log + payload store, shared with the DebugScreen.
 *
 * Pure TypeScript (no JSX) so any screen or controller can import it: console
 * activity lands in a ring buffer the debug screen renders as a tail, and any
 * structured payload (e.g. the last report this phone SENT) is kept under a
 * key for raw inspection. Kept framework-free so the Soshin/E2E reworks can
 * adopt the same helpers later.
 */

/** Ring-buffer limit: the newest `LOG_LIMIT` lines are kept. */
export const LOG_LIMIT = 200;

export interface LogEntry {
  /** Line timestamp (ms epoch). */
  t: number;
  /** One rendered log line. */
  text: string;
}

const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Compose arbitrary parts into one human-readable line. */
function formatPart(part: unknown): string {
  if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") {
    return String(part);
  }
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}

/** Append one composed line; also echoes to console.log so it reaches logcat. */
export function logEvent(...parts: unknown[]): void {
  const entry: LogEntry = {
    t: Date.now(),
    text: parts.map(formatPart).join(" "),
  };
  entries.push(entry);
  if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
  console.log(`[app] ${entry.text}`);
  emit();
}

/** Current snapshot of the ring buffer (oldest first). */
export function logEntries(): LogEntry[] {
  return [...entries];
}

/** Subscribe to log changes; returns an unsubscribe function. */
export function subscribeLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Latest structured payloads (the Debug screen reads these as raw JSON). */
const payloads = new Map<string, unknown>();

/**
 * Store the most recent value for a key. Use for high-signal diagnostics that
 * would flood the text log (last report sent, last server verdict, …). One
 * value per key — callers that need history should logEvent their summary.
 */
export function logPayload(key: string, value: unknown): void {
  payloads.set(key, value);
}

/** Read the latest payload stored under a key (null when never recorded). */
export function getPayload<T = unknown>(key: string): T | null {
  const value = payloads.get(key);
  return value === undefined ? null : (value as T);
}

/** Every recorded payload as a plain object (Debug screen "all payloads"). */
export function allPayloads(): Record<string, unknown> {
  return Object.fromEntries(payloads);
}

export { LogTailer } from "./LogTailer";
