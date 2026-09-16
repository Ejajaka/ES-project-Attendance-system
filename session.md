# session.md — context for the next agent

> **Latest session (2026-09-17, BUILD 21):** role rename to
> TRANSMITTER/RECEIVER (Soshin/Jushin kept as brand), 3 preset rooms, hotspot
> auto-join, and three-channel link stats (BLE/WiFi/ultrasonic) — delivered
> with TDD (114 tests). A simulated receiver (`npm run sim:rx`) verifies the
> full server pipeline with one phone (code verified, all channels green).
> Full report: `docs/session-2026-09-17-report.md`. Next steps: `todo.md` §P10
> (notably: finish the two-phone pass on BUILD 21 and tune cross-device
> ultrasonic detection).

Session goal: get Shusseki (room-level attendance via BLE + WiFi + ultrasonic
fusion) into a **working Android release APK that runs on the emulator**, and
move the repo's toolchain from **bun → npm**.

## The project (current state)

**npm-workspaces monorepo** (PLAN.md):
- `shared/` — pure TS rolling codes (RFC 6238/HMAC-SHA1), per-modality
  confidence, fusion, evaluation metrics, Zod schemas. Runtime-agnostic (no
  `node:crypto`).
- `server/` — Hono fusion server. Runs on **Node** via `@hono/node-server` +
  `tsx` (`npm run dev`), still Cloudflare-Workers compatible (`app` = Hono).
  **65 unit tests pass** (`npm test` → Vitest across shared/server/
  evaluation/app).
- `app/` — Expo SDK 52 / RN 0.76.9 app (Soshin room + Jushin phone modes;
  native modules `app/modules/expo-shusseki-{ble,wifi,ultrasonic,biometric}`,
  Kotlin/Swift only — no NDK needed).
- `evaluation/` — comparative runner (`npm run run:sample -w evaluation`).

## What happened

1. **Toolchain bun → npm.** Converted workspaces (`workspace:*` → `*`), removed
   root `"packageManager": "bun"` and duplicated root `expo-*` deps (the latter
   were pulling `expo@57`/`rn@0.87` through `"expo": "*"` peers), tests
   `bun:test` → Vitest (all 10 files), server `Bun.serve` → `@hono/node-server`
   + `tsx`, shell helpers + README + todo.md → npm. Dropped the bun-only
   `.bun`-scanning band-aid in `app/metro.config.js` (clean npm-workspaces
   config). Commit `b6ba8a1`.
2. **`expo.core.ExpoModulesPackage` build error** — upstream autolinking bug.
   Fixed durably with the project-level `app/react-native.config.js` override
   (NOT a native stub; `app/android/` is prebuild-generated). See
   `arch-installation-quirks.md` #4.
3. **`crypto.randomUUID()` crashed release builds in Hermes** →
   `"main" has not been registered`. Fixed with a fallback id in
   `app/src/App.tsx` (commit `b6ba8a1`). See quirks #5.
4. **Emulator disk space** — the userdata check is a hard ~7.4 GB regardless of
   config. Freed caches (`~/.bun/install`, `~/.gradle/caches`, `~/.npm`,
   `pacman -Scc`, ghcup, 101 orphans) → `/` 94% → 83%. See quirks #6.
5. **Gradle cache corruption** after deleting `~/.gradle/caches` under a live
   daemon → `./gradlew --stop` first. See quirks #7.
6. **P0 verified ✅** — the old `globalThis.expo`/EventEmitter black screen is
   gone. The **release APK renders** on the API-35 emulator (AVD `shusseki`):
   `uiautomator dump` shows "Shusseki", "RUN AS SOSHIN (ROOM)", "RUN AS JUSHIN
   (PHONE)". Emulator runs windowed on `DISPLAY=:0` (Hyprland).

## Environment prerequisites (this machine, verified)

- **npm 12** + Node **24.18.1** (Expo SDK 52 works here; pin older Node via `n`
  only if a future Arch `nodejs` bump breaks the CLI).
- JDK **21** at `/usr/lib/jvm/java-21-openjdk` (Gradle 8.10 needs it, not 25).
- Android SDK `/opt/android-sdk` (`platforms/android-35`, build-tools, emulator,
  system image `system-images;android-35;google_apis;x86_64`), AVD `shusseki`.
- KVM present (`/dev/kvm`).

## Key locations

- Generated native project: `app/android/` (gitignored; regenerate with
  `npx expo prebuild --platform android`).
- Autolinking fix: `app/react-native.config.js` (must stay in the repo).
- APKs: `app/android/app/build/outputs/apk/{debug/app-debug.apk,
  release/app-release.apk}`.
- Full issue+fix log: `arch-installation-quirks.md` (Troubleshooting §),
  `docs/android-diagnostics.md`, `todo.md` (P0/P1 done).

## Commits on `main`
- `b6ba8a1` chore: migrate to npm workspaces + get the app running on the
  Android emulator
- (this) docs: session/troubleshooting updates
- earlier (already on main): `754371e` fix: self-contained release APK +
  Metro bundling + pure-JS rolling code; `94a15f1` docs: android diagnostics

## Next steps (see todo.md P2+)
- P2 release-signing for the Play Store (currently debug-signed).
- P3 device-level runtime verification (BLE/WiFi/ultrasonic/biometric) — needs
  real hardware; emulator can't exercise the sensors.
- Cleanup: `npm run lint` needs a `biome.json` excluding `app/android/**`;
  optionally drop `@types/bun` + `"bun"` from `app/tsconfig.json` `types`.
