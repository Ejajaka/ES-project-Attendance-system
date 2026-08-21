# ADR 0005 — Monorepo with a decoupled pure-logic core

**Status:** Accepted

## Context
The research value is in the *comparative evaluation* (BLE vs WiFi vs
Ultrasonic vs Fused). That math must be testable without a device, while the
app logic must run on phones. We also need the logic shared between the app and
the server.

## Decision
Bun-workspaces monorepo:
- **`shared`** — pure, framework-free logic: rolling code, per-modality
  confidence, fusion, evaluation metrics, Zod report schemas. Fully TDD-tested in
  bun.
- **`server`** — Hono fusion server (Bun / Cloudflare Workers). Ingests reports,
  re-verifies codes, computes presence + evaluates vs ground truth.
- **`app`** — Expo/React Native app (Soshin + Jushin modes). Depends on `shared`
  and on native modules.
- **`evaluation`** — comparative-study runner + scripts.

The app keeps a clean **seam** (`DeviceSensors`) between pure logic and native
sensors, so the Soshin/Jushin controllers are TDD-tested with `MockSensors`
without a device.

## Consequences
- Core research logic is verified by 64 automated tests, runnable anywhere bun
  runs.
- Native modules (`modules/expo-shusseki-*`) are the only device-dependent code
  and are isolated behind the `DeviceSensors` interface + `nativeSensors.ts`.
- `shared` is a `workspace:*` dependency of both `server` and `app`.
