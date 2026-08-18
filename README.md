# Comparative Evaluation of BLE, WiFi, and Ultrasonic Signals for Room-Level Continuous Attendance Monitoring

## Overview

Conventional attendance systems rely on active participation (swiping a card, signing a sheet, scanning a QR code), record presence at a single point in time, and often need extra anti-spoofing measures bolted on afterward. This project explores a passive alternative: fixed IoT nodes installed in a room continuously sense a phone's BLE, WiFi, and ultrasonic signals and report them to a server, which fuses the three signal types to determine whether a person is present in that specific room — for the whole duration they're there, not just at one checkpoint.

An Android app running on each user's phone acts as the mobile-side signal source, and performs a lightweight on-device biometric check (fingerprint/face) simply to give reasonable confidence that the phone is being carried by its actual owner rather than left behind by someone else to fake presence. This check is a supporting safeguard, not the core research focus.

## Research Question

Which single signal — BLE, WiFi, or ultrasonic — best supports accurate room-level presence detection, and does fusing them outperform any one signal alone?

## Core Idea

- **Fixed IoT nodes** (one or more per room) continuously capture:
  - BLE advertisement/RSSI data from the phone
  - WiFi RSSI data from the phone
  - Ultrasonic signal data (emitted/received between node and phone)
- Each node reports these raw values to a **central server**.
- The server evaluates each signal individually and in fusion to classify room presence.
- **Ground truth** for evaluation is established manually — a human headcount in the controlled test room — against which each method's output is compared.
- The Android app additionally performs an **on-device biometric check** (not periodic, just enough to establish it's the owner using the phone) as a basic anti-spoofing measure.

## What Makes This "Comparative"

The main contribution isn't the system alone — it's benchmarking:
1. **BLE-only** detection accuracy
2. **WiFi-only** detection accuracy
3. **Ultrasonic-only** detection accuracy
4. **Fused (BLE + WiFi + Ultrasonic)** detection accuracy

against the manually counted ground truth, in a controlled environment, to determine which modality (or combination) is most reliable for distinguishing "in this room" from "not in this room."

## Status

Early-stage research project. See `PLAN.md` for the working plan, open questions, and next steps.

## Repository Structure (proposed)

```
/node-firmware/       # Code running on the fixed IoT nodes (BLE scan, WiFi RSSI capture, ultrasonic emit/receive)
/android-app/         # Android app: BLE/WiFi/ultrasonic signal emission, biometric check, server reporting
/server/              # Central server: data ingestion, per-signal and fused classification logic
/evaluation/          # Scripts and logs for comparing outputs against manual headcount ground truth
/docs/                # Design notes, test protocols, results
PLAN.md
README.md
```
