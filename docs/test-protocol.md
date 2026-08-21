# Test Protocol — Shusseki Comparative Evaluation

This protocol operationalises PLAN.md §2 and §4. The comparative claim is about
how well each modality **detects true presence** *and* **rejects near-miss
non-presence**. Both halves must be tested — otherwise "room-level" is undefined.

## Definitions
- **Modalities:** `ble`, `wifi`, `ultrasonic`, and `fused` (BLE+WiFi+Ultrasonic).
- **Ground truth:** manual headcount per Session (primary). Per-identity linkage
  to `deviceId` is a deferred nice-to-have (PLAN §2).
- **Decisions** come from `shared` `decide(confidence, threshold=0.5)`; the
  study compares each modality's decision and the fused decision against truth.

## Before the first collection session (PLAN §5)
Lock these *before* collecting real data — they are expensive to redo:
1. **BLE combining rule** — default `max` (ADR 0002). Decide and record.
2. **Target sample size** — rooms × sessions × distinct devices × presence/absence
   points. Aim for enough to make a modality comparison meaningful, not one
   afternoon.

## Positive cases (true presence)
For each modality, confirm it *fires* when the person is genuinely in the room:
- **BLE:** person stands at centre, near each wall, and at the doorway-inside.
- **WiFi:** person connected to the Soshin hotspot at varying distances.
- **Ultrasonic:** person within Soshin speaker range (quiet vs noisy room).
- **Fused:** all of the above — expect equal-or-better recall than any single
  modality (see `evaluation/run-sample.ts`).

## Negative cases — room-boundary bleed (the crux, PLAN §4)
Each modality must be tested for **false positives just outside the room**,
because BLE/WiFi leak through drywall/glass and near-ultrasonic leaks through
open doors:
- **Adjacent room occupied** — a device in the next room; expect the system to
  say *not in this room*.
- **Just outside the door** — device in the corridor / immediately outside;
  expect *not in this room*.
- **Open-door bleed** — door open between room and corridor with a device just
  outside; especially stresses ultrasonic + BLE.
- **Far but connected** — device on the Soshin WiFi from a distant spot (WiFi
  reach > room); expect WiFi to be wrong unless combined with BLE/ultrasonic.

Record, per negative case, *why* a signal was missed/accepted:
`missReason` (`none | service_killed | no_signal | decode_failed`) is logged by
the ultrasonic decoder so a dead background service is not silently conflated
with "ultrasonic doesn't work" (PLAN §4).

## Per-modality measurement
1. Run a controlled Session (positive + negative placements above).
2. Devices report via the app; the Server ingests and computes per-modality +
   fused confidence at each tick.
3. Take manual headcount(s) as ground truth (`POST /api/sessions/:id/ground-truth`).
4. `GET /api/sessions/:id/evaluate` returns room-level count error.
5. When per-identity linkage exists, `evaluateInstances` returns precision /
   recall / F1 per modality and fused (the headline comparison).

## Reporting
- Report BLE-only, WiFi-only, Ultrasonic-only, and Fused accuracy side by side.
- State the BLE combining rule and sample size used.
- Flag device heterogeneity as a confound (mic/speaker/antenna variance) and, if
  possible, control the device pool or report it.
- Note the known limitation: plain headcount cannot distinguish equal-and-opposite
  per-modality false positives/negatives (PLAN §4).
