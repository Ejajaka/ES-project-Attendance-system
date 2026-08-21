# session.md — context for the next agent

Session goal: get Shusseki (room-level attendance via BLE + WiFi + ultrasonic
fusion) into a **working Android release APK**, on a clean `fix/release-apk`
branch. Branch was merged to `main`.

## The project

Bun-workspaces monorepo (PLAN.md):
- `shared/` — pure TS rolling codes (RFC 6238/HMAC-SHA1), per-modality
  confidence, fusion, evaluation metrics, Zod schemas.
- `server/` — Hono fusion server (Bun / Cloudflare Workers). **65 unit tests
  pass** (`bun test`).
- `app/` — the old Expo (bun) app (Soshin room + Jushin phone modes; native
  modules `app/modules/expo-shusseki-{ble,wifi,ultrasonic,biometric}`).
- `evaluation/` — comparative runner.

## What happened this session

### 1. Original bug: "unable to load script" (debug APK, no Metro)
Fixed by building a **release** APK that embeds the JS bundle
(`assets/index.android.bundle`, Hermes bytecode). `./gradlew assembleRelease`
with `bundleCommand = "export:embed"` + sign with debug keystore.

### 2. bun `.bun` hoisting broke Metro
bun hoists transitive deps into `node_modules/.bun/<pkg>@<ver>` which Metro's
default resolver can't see. Fixed with `app/metro.config.js` listing those dirs.
**This was a band-aid.**

### 3. `shared` imported `node:crypto` → not RN-bundleable
Rewrote `shared/src/rollingCode.ts` as pure-JS HMAC-SHA1 (no Buffer), added an
RFC 6238 conformance test. **65 tests green.** `shared` is now runtime-agnostic.

### 4. Deeper bug: new-arch `globalThis.expo` undefined
`TypeError: Cannot read property 'EventEmitter' of undefined` at startup (black
screen on a Pixel + emulator). Root cause: the original hand-assembled Expo app
had broken new-architecture (Bridgeless) expo-modules-core host wiring —
`globalThis.expo` was never installed natively. Not a JS bug.

### 5. The real fix: rebuild the app the standard way with **npm**
`bun`'s hoisting fights Metro + Expo native autolinking. Recreated the app via:

```bash
npx create-expo-app@latest shusseki-clean --template blank@sdk-52   # npm
```

and transplanted `app/src/**` + `app/modules/expo-shusseki-*`, rewired
`package.json` / `app.json`, added `metro.config.js` so Metro can watch the
sibling `shared` workspace package.

**Result: `BUILD SUCCESSFUL` — a 61 MB self-contained release APK**, with
`expo@52.0.49` + `expo-modules-core@2.2.3` (consistent), and **no** `expo.core
.ExpoModulesPackage` stub needed (the fresh template wires expo-modules-core
correctly).

### Environment prerequisites (this machine)
- Node **20** at `/usr/local/bin/node` (via `n`) — Node 26 / Bun can't run Expo.
- JDK **21** at `/usr/lib/jvm/java-21-openjdk` (Gradle 8.10 needs it, not 25).
- Android SDK `/opt/android-sdk` (`platforms/android-35`, build-tools, ndk,
  emulator), system image `system-images;android-35;google_apis;x86_64`, AVD
  `shusseki` (`avdmanager`).
- Gradle 8.10.2 pre-seeded in `~/.gradle/wrapper/dists/gradle-8.10.2-all/*/`
  (wrapper's 10 s connect timeout can't download it; `curl -L` did).

## Key locations
- **Clean npm app (the working build):** `./.tmp/shusseki-clean`
  (gitignored). Release APK:
  `./.tmp/shusseki-clean/android/app/build/outputs/apk/release/app-release.apk`
- `app/metro.config.js` — bun-only band-aid (remove once app/ is the npm build).
- `docs/android-diagnostics.md` — full diagnosis.

## NOT YET VERIFIED (gap)
The clean npm release APK **built successfully but was not yet run on the
emulator before this session ended** (emulator became unstable under automated
launch). It must be verified to RENDER (fix the black screen) before declaring
victory. See `todo.md`.

## Commits on `fix/release-apk` (fast-forwarded to main)
- `754371e` fix: self-contained release APK + Metro bundling + pure-JS rolling code
- `94a15f1` docs: android diagnostics
- (this) context files