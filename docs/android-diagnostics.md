# Android build & diagnostics notes

Branch: `fix/release-apk` — these notes accompany that work.

## The original problem

`unable to load script` when installing the **debug** APK. A debug build
intentionally omits the JS bundle and expects Metro at runtime. The fix is a
**release** build that embeds the bundle.

## Building a self-contained release APK

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"          # Gradle 8.10 needs Java 21, not 25
cd app/android
./gradlew assembleRelease
# → app/android/app/build/outputs/apk/release/app-release.apk
```

The release build:
- bundles JS via `expo export:embed` (Metro `bundleCommand = "export:embed"`),
- signs with the debug keystore (preconfigured), and
- embeds the Hermes bytecode at `assets/index.android.bundle` (magic `c6 1f bc 03`).

**Required native stub:** `app/android/app/src/main/java/expo/core/ExpoModulesPackage.java`
is hand-added (and regenerated after each `expo prebuild --clean`). It exists
because `expo-modules-autolinking@2.0.8` still emits the legacy
`new expo.core.ExpoModulesPackage()` in `PackageList.java`, a class removed in
`expo-modules-core@2.2.3`. The stub keeps that file compiling.

## Environment prerequisites (this machine)

- Node 20 at `/usr/local/bin/node` (`n` installed) — Node 26 / Bun can't run the
  Expo CLI (RN `import typeof` + TS stripping).
- JDK 21 at `/usr/lib/jvm/java-21-openjdk` — set as `JAVA_HOME`.
- Gradle 8.10.2 manually seeded into `~/.gradle/wrapper/dists/gradle-8.10.2-all/*/`
  (the wrapper's 10s connect timeout can't download it; fetch with `curl -L`).
- Android SDK at `/opt/android-sdk` (chown'd to user), `platforms/android-35`,
  `build-tools/35-37`, `platform-tools`, `ndk 27`.
- `expo-modules-core` pinned to `~2.2.3` (aligns native + JS with `expo@52.0.49`).

## Emulator diagnostics (done)

```bash
android sdk install "system-images;android-35;google_apis;x86_64"
echo no | /opt/android-sdk/cmdline-tools/latest/bin/avdmanager create avd \
  -n shusseki -k "system-images;android-35;google_apis;x86_64" -d pixel_5 --force
/opt/android-sdk/emulator/emulator -avd shusseki -no-window -no-audio \
  -gpu swiftshader_indirect -no-snapshot &   # KVM accelerated (/dev/kvm present)
adb install -r app-release.apk
adb shell am start -n com.shusseki.app/.MainActivity
adb logcat -d | grep ReactNativeJS
```

## The remaining blocker

The release APK installs and launches; the JS bundle loads (`ReactNativeJS:
Running "main"`), then:

```
E ReactNativeJS: TypeError: Cannot read property 'EventEmitter' of undefined
E ReactNativeJS: Invariant Violation: "main" has not been registered.
```

`EventEmitter.ts` reads `globalThis.expo.EventEmitter`; `globalThis.expo` is
installed by `expo-modules-core`'s **JSI** (`JSIContext.installJSIForBridgeless`,
Bridgeless / new architecture) at native host creation. In this hand-assembled
project `globalThis.expo` is never installed even though:
- `libexpo-modules-core.so` + `libappmodules.so` load,
- `ExpoModulesPackageList.java` (new-arch provider) lists all modules,
- there are **no** `NoClassDefFoundError` / `ExpoModulesHelper` load errors.

That points to the native new-architecture (Bridgeless) host wiring in the
hand-rolled Expo project, not to the JS or the bundle.

### Recommended fix

Rebuild the app as a proper Expo project and transplant our code, i.e. the
standard, well-trodden path:

1. `npx create-expo-app@latest --template blank@sdk-52` and install with **npm**
   (not bun — bun's `.bun` hoisting fights Metro resolution and native
   autolinking).
2. Copy in `app/src/**` and `app/modules/expo-shusseki-*`.
3. Merge `app/app.json` (permissions, plugins pointing at `app.plugin.js`).
4. Add `shared` (pure JS RollingCode now, so it bundles on RN) as a dep, plus
   the `metro.config.js` workspace fix.
5. `npx expo run:android --variant release`, verify with the emulator above.

Alternatively test `newArchEnabled: false` — but on SDK 52 the legacy path is
de-emphasized, and the current empty `ExpoModulesPackage` stub would need to
delegate to `ReactAdapterPackage`/`ExpoModulesPackageList` to load modules.