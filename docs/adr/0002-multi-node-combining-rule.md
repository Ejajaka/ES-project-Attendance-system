# ADR 0002 — Default BLE combining rule is `max`

**Status:** Accepted (provisional — PLAN §4 flags this as a decision to make
before the first data-collection session)

## Context
With several BLE nodes per room, "BLE-only accuracy" is undefined until we
decide how to combine per-node RSSI: best single node, `max` across nodes,
`average`, or a trilateration estimate. This choice changes what the reported
number means.

## Decision
Default to **`max`** (equivalently `best` for a monotonic map): if *any* node
sees a strong signal, the device is treated as "within walkable distance of the
room." BLE/WiFi are treated as approximate, supplementary proximity sensors,
not precise localizers.

`avg` is also implemented and can be selected per session for a stricter, more
conservative estimate.

## Consequences
- The reported BLE-only number is a generous "is this phone near the room?"
  signal rather than a fix.
- The choice is explicit and per-session in `SessionConfig.bleRule`, so the
  comparative study can be re-run with either rule without code changes.
- **Action item (PLAN §5):** lock the rule and the target sample size *before*
  the first real collection session — changing it later invalidates comparisons.
