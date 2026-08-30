/**
 * Stable-enough device id for the prototype (resets on reinstall) + version.
 * Prefers `crypto.randomUUID()` when the runtime exposes it, but falls back to
 * a pseudo-random id — Hermes / React Native doesn't always provide a global
 * `crypto` object (it's absent on Android release builds).
 */
export function randomIdPrefix(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.();
  if (uuid) return uuid.slice(0, 8);
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  ).slice(0, 8);
}

export const DEVICE_ID = `phone-${randomIdPrefix()}`;