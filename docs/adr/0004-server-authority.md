# ADR 0004 — Server is the authority on rolling-code verification

**Status:** Accepted

## Context
The plan states client-side rolling-code checking is a fast pre-check, not a
security boundary. A Jushin could be spoofed or report a bogus `valid: true`.

## Decision
The fusion **Server** re-computes `verifyTOTP(secret, code, timestamp)` for every
ultrasonic observation using the session secret. The device-supplied `valid`
field is ignored; only server verification decides ultrasonic confidence.

## Consequences
- `server/src/presence.ts#verifyUltrasonic` is the single source of truth.
- A tampered/invalid code yields `ultrasonicServerValid: false` even if the
  device claimed success — covered by `server/src/presence.test.ts`.
- The session secret is provisioned out-of-band (Soshin + Server share it); the
  prototype exchanges it via `POST /api/sessions`. Not a production-grade secret
  store.
