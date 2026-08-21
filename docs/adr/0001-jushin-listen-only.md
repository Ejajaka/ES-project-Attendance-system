# ADR 0001 — Jushin never transmits ultrasound

**Status:** Accepted (decided in PLAN.md §3)

## Context
A room full of phones each transmitting ultrasound would create an
unsolvable multi-transmitter acoustic collision problem, and would burn battery
on every participant's speaker.

## Decision
Only the **Soshin** (room-side device) transmits the ultrasonic rolling code.
The **Jushin** (phone people carry) is a **listen-only** receiver. If
client-specific ultrasonic messages are ever needed, the Soshin acts as the sole
broadcast hub and schedules/relays them. This removes the collision problem by
construction.

## Consequences
- The ultrasonic modality is effectively single-transmitter → simple, reliable
  decode on the Jushin side.
- Per-Jushin frequency calibration (PLAN §1) remains possible because there is
  only one transmitter to tune against.
- This is enforced in code: `SoshinController.broadcast()` calls
  `ultrasonic.transmit()`; `JushinController` only calls `ultrasonic.listen()`.
