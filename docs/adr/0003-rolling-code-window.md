# ADR 0003 — Rolling-code tolerance window is wider than typical TOTP

**Status:** Accepted (provisional — tunable per session)

## Context
The Soshin broadcasts a TOTP-like rolling code (RFC 6238, HMAC-SHA1) via
ultrasound. Clock drift between Soshin, Jushin, and Server, plus ultrasonic
demodulation latency, means a strict ±0-step window would reject many *valid*
presences. A wider window weakens anti-replay guarantees, so the width is a
deliberate tradeoff, not a default.

## Decision
- Rolling code = RFC 6238 with configurable `step` (default 30s), `digits`
  (default 6), and `window` (default **1** step each side).
- The `window` is a **per-session** parameter (`SessionConfig.window`) so the
  study can size it deliberately and report the anti-replay implication.
- The **Server is the final authority**: it re-verifies every code against the
  session secret (ADR 0004). The Jushin's `valid` flag is advisory only.

## Consequences
- Default window=1 tolerates ~±30s of drift/latency — fine for the prototype.
- For harsher acoustic environments, widen to 2–3 and note the weaker replay
  bound in write-ups.
- Implementation: `shared/src/rollingCode.ts`, used by `SoshinController`
  (generate) and `server/src/presence.ts` (verifyTOTP).
