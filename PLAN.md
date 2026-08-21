# PLAN.md — Shusseki: Room-Level Presence via BLE + WiFi + Ultrasonic Fusion

## Status
Early-stage. This plan covers the prototyping phase: two-mode React Native app on
consumer Android hardware, used to validate the idea before any move to dedicated
microcontrollers/sensors.

---

## 1. Prototype Architecture

### App: Shusseki (single codebase, two modes)

- **Soshin mode** — the fixed/room-side device.
  - Acts as a WiFi hotspot (or local network hub) for Jushin devices to connect to.
  - Transmits ultrasonic rolling-code / TOTP-like tones. **Soshin is the only
    transmitter of ultrasonic signal** — Jushin devices never transmit ultrasound.
  - Advertises/scans BLE.
  - Acts as an old-school broadcast hub: if client-specific ultrasonic messages are
    ever needed, Soshin relays/schedules them rather than clients transmitting
    directly, avoiding a multi-client acoustic collision problem entirely.
  - Optionally calibrates per-Jushin transmission frequency (a per-client tuning step)
    to get the best signal for each listening device.
  - Performs local (client-side, i.e. node-side) verification of rolling codes as a
    fast pre-check, in addition to server-side verification as the authority.

- **Jushin mode** — the phone people carry to prove presence.
  - Connects to Soshin's WiFi/hotspot.
  - Reports its own BLE interface info + whatever it observes of Soshin's BLE signal,
    for server-side cross-checking.
  - Reports maximal available WiFi signal info about Soshin for server-side prediction.
  - **Listens only** for Soshin's ultrasonic rolling code/TOTP signal and reports back
    what it received, via local WiFi or internet — does not transmit ultrasound itself.
  - Performs on-device biometric checks (fingerprint/face) at start-of-attendance and
    end-of-attendance, as a basic (non-core, non-cryptographic) anti-spoofing signal.

### Server
- Ingests BLE, WiFi, and ultrasonic reports from all Soshin/Jushin devices in a room.
- Computes BLE-only, WiFi-only, Ultrasonic-only, and Fused presence confidence.
- Is the final authority on rolling-code verification (client-side check is a
  pre-check/optimization, not a security boundary).

### Multiple BLE nodes per room
- Several BLE nodes (Soshins or dedicated BLE-only nodes) placed around a room to
  give a "within walkable distance of the room" signal — treated explicitly as an
  approximate, supplementary sensor rather than a precise localizer.

---

## 2. Comparative Evaluation (the actual research contribution)

Benchmark, against manually-established ground truth, in a controlled room:

1. BLE-only detection accuracy
2. WiFi-only detection accuracy
3. Ultrasonic-only detection accuracy
4. Fused (BLE + WiFi + Ultrasonic) detection accuracy

Ground truth: manual headcount for now. Linking headcount to specific
identity/device (MAC or similar) is a nice-to-have, not required for v1.

---

## 3. Decisions Already Made

- **2-minute WiFi scan throttle (Android 9+)** — accepted as a fine compromise for
  this project; not being engineered around.
- **BLE RSSI accuracy** — accepted as inherently noisy/"hope-powered" for room-level
  precision; multiple nodes per room used to get a decent "is this walking distance
  from the room" signal rather than a precise fix.
- **Ultrasonic collision problem** — resolved architecturally: Jushin devices never
  transmit ultrasound, only listen. Soshin is the sole transmitter and acts as a
  broadcast hub if client-specific messages are ever needed, with optional
  per-client frequency calibration. This avoids the multi-transmitter acoustic
  collision problem that would otherwise occur with many phones in one room.
- **Cross-OEM behavior** — not being treated as a blocker. Handling OEM quirks
  (background throttling, Doze, radio management differences) is explicitly part
  of what the experiment is trying to observe, not something to solve away upfront.
- **Ground truth granularity** — plain headcount is the primary target for now;
  per-identity linkage to MAC/device is deferred.
- **Anti-spoofing (facial scan)** — deliberately out of core scope; not being
  treated as a hard security requirement for this phase.
- **Development quirks (hotspot APIs, native modules, etc.)** — left to the
  developer to handle as they arise; not a planning blocker.

---

## 4. Open Questions / Things to Be Aware Of

These are not blockers — they're flagged so a conscious compromise can be made for
each, either now or when they surface during prototyping.

### Signal & OS-level
- **WiFi RSSI granularity**: `WifiManager.getConnectionInfo().getRssi()` may be
  coarsened on some OEM skins, and requires fine location permission + location
  services enabled to return anything at all. No RN module exists for this — a
  native Android module will be needed regardless of LLM-assisted coding speed.
- **Background mic access for ultrasonic listening**: continuous background
  listening runs into the same Doze/background-service-kill issues as WiFi/BLE
  scanning, plus foreground-service notification requirements to stay alive.
  Worth logging *why* a signal was missed (service killed vs. no signal vs.
  demodulation failure) — otherwise a dead background service looks identical to
  "ultrasonic doesn't work" in the results, silently conflating an OS quirk with a
  modality's real ceiling.
- **Rolling code / TOTP tolerance window**: clock drift between Soshin, Jushin, and
  server, plus ultrasonic demodulation latency, likely needs a wider validity
  window than a typical 30s TOTP. Wider window = fewer false rejects but weaker
  anti-replay guarantees — a tradeoff to size deliberately, not by default.
- **WiFi hotspot mechanics**: `LocalOnlyHotspot` (or equivalent) has multi-client
  limits and OEM-dependent quirks; reliably creating/tearing it down in a
  foreground service across Android versions is worth a short early spike.

### Study design / measurement validity
- **Room-boundary bleed (all three modalities, not just ultrasonic)**: BLE and WiFi
  pass through drywall/glass and can pick up phones in adjacent rooms or corridors;
  even near-ultrasonic can leak through open doors/thin walls. This is the actual
  crux of "room-level" being harder than "building-level" — worth designing
  negative-case tests explicitly (someone just outside the door, adjacent room
  occupied) since the comparative claim depends on how well each modality *rejects*
  near-miss non-presence, not just how well it detects true presence.
- **Multi-node combining rule**: with multiple BLE (and possibly WiFi) nodes per
  room, "BLE-only accuracy" isn't well-defined until you decide whether it means
  best single node, max across nodes, average, or a trilateration-style estimate.
  This choice changes what the reported number actually means — worth deciding (and
  maybe trying a couple of ways) before the data collection protocol is locked in.
- **Sample size / session count**: a comparative "modality A beats modality B" claim
  needs more than one room/afternoon/handful of phones to mean anything. Worth
  roughly deciding upfront: how many rooms, how many sessions, how many distinct
  devices per session, and an approximate target number of presence/absence data
  points — this tends to become the real bottleneck (data collection + calibration
  time), more than app engineering.
- **Device heterogeneity as a confound**: mic sensitivity, speaker frequency
  response, antenna placement, and OS radio management all vary by phone. If test
  participants use their own phones, "which modality performed best" may partly
  measure "which modality is least sensitive to hardware variance" — worth deciding
  whether to control the device pool or explicitly report this as a confound.
- **Identity-level ground truth (deferred but worth flagging)**: plain headcount
  ("12 counted, system said 11") can't distinguish real per-modality precision/recall
  from equal-and-opposite false positives/negatives. Fine to defer, but worth noting
  in write-ups as a known limitation of the v1 evaluation.

### Ethics / process
- **Human-subjects data**: facial scans plus continuous audio/RF sensing of real
  people is the kind of data collection that may need ethics/IRB sign-off even for
  a low-stakes study, depending on context (course project, thesis, etc.). Worth a
  quick check with a supervisor before deep data collection begins, not after.

---

## 5. Suggested Order of Operations

1. Build Shusseki (Soshin + Jushin modes) with basic connectivity: hotspot join,
   BLE scan/advertise, ultrasonic transmit (Soshin) / listen (Jushin).
2. Short spikes on the known rabbit holes: `LocalOnlyHotspot` lifecycle, background
   mic access reliability, WiFi RSSI availability across a couple of test OEMs.
3. Decide the multi-node BLE combining rule and rough target sample size *before*
   the first real data collection session — these are the two decisions that are
   expensive to redo retroactively.
4. Run early smoke tests to surface OS-specific quirks empirically (faster than
   further armchair analysis).
5. Design the negative-case (room-boundary bleed) test protocol alongside the
   positive-case protocol from the start.
6. Begin controlled data collection: BLE-only, WiFi-only, Ultrasonic-only, Fused,
   against manual headcount ground truth.
