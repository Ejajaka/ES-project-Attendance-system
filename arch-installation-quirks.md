# Shusseki — installation & support (Arch Linux)

Everything needed to build the Android app and run the emulator on **Arch
Linux**. Written from worked sessions on Arch `x86_64`; adjust paths/versions
to taste. Other distros: see the "porting notes" at the end.

> Short version: Node (LTS-ish, 24 works for SDK 52) + npm + JDK 21 + Android
> SDK (API 35). The project is an **npm workspaces** monorepo; text below that
> says "bun" is stale unless it's in the troubleshooting section.

## 1. Node + package manager

Use **npm** for this repo (bun was migrated away — see `session.md` /
`todo.md` P1). Current verified set on this machine:
Node **v24.18.1** + **npm 12**. That ran `expo prebuild`, Metro
`export:embed`, and Gradle fine with Expo SDK 52.

If a future SDK/toolchain chokes on bleeding-edge Node (an Arch `nodejs` bump
has broken Expo before), pin a controllable version with `n`:

```bash
npm install -g n
sudo n 20          # or whatever LTS the SDK wants; /usr/local/bin wins PATH
hash -r; node --version
```

## 2. JDK 21 (Gradle 8.10 / AGP need ≤ 21; JDK 25 is too new)

```bash
sudo pacman -S --needed jdk21-openjdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"     # export in ~/.zshrc too
java -version                            # -> 21.x
```

Do **not** point Gradle at `java-25-openjdk`.

## 3. Android SDK (`sdkmanager` + `avdmanager`)

```bash
sudo mkdir -p /opt/android-sdk
# cmdline-tools first: download commandlinetools-linux-*.zip from
# https://developer.android.com/studio#command-line-tools-only
# unzip to /opt/android-sdk/cmdline-tools/latest
sudo chown -R "$USER":"$USER" /opt/android-sdk   # or installs fail
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
sdkmanager "emulator" "system-images;android-35;google_apis;x86_64"
```

No NDK needed — the native modules (`app/modules/expo-shusseki-*`) are Kotlin
only.

## 4. Create an AVD (emulator "device")

```bash
echo no | avdmanager create avd \
  -n shusseki -k "system-images;android-35;google_apis;x86_64" -d pixel_5 --force
```

KVM must work for usable performance (`ls -l /dev/kvm`).

## 5. Run the emulator

**Windowed (you want to see the screen):**

```bash
export DISPLAY=${DISPLAY:-:0}     # X/XWayland; works from Hyprland too
/opt/android-sdk/emulator/emulator -avd shusseki \
  -gpu swiftshader_indirect -no-audio -no-snapshot -no-metrics &
```

**Headless (CI / no display):** same with `-no-window`.

Wait for boot, then drive via adb:

```bash
adb wait-for-device
adb shell getprop sys.boot_completed   # until it prints "1"
adb install -r app-release.apk
adb shell am start -n com.shusseki.app/.MainActivity
adb logcat -d | grep ReactNativeJS
adb exec-out screencap -p > screen.png
```

## 6. Gradle

Expo/RN's wrapper downloads Gradle itself; if the 10 s connect timeout gives up
on a big/redirected download, seed it into
`~/.gradle/wrapper/dists/gradle-8.10.2-all/<hash>/` with `curl -sL`.

## 7. Build the APKs (npm toolchain)

```bash
cd app
npx expo prebuild --platform android      # generates app/android (gitignored)
cd android
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"
./gradlew assembleDebug                   # and/or assembleRelease
ls app/build/outputs/apk/{debug,release}/
```

Run `expo prebuild` again after changing `app.json`/native config; keep
`app/react-native.config.js` (see troubleshooting) in the repo.

---

## Troubleshooting — issues that stopped us & their fixes (2026-08)

All were hit and fixed while moving the repo to the npm toolchain and getting
the app rendering on the emulator.

### 1. npm doesn't accept `workspace:*` ("Unsupported URL Type")
`npm install` fails with `EUNSUPPORTEDPROTOCOL workspace:*`. npm (unlike
yarn/pnpm/bun) has no `workspace:` protocol. **Fix:** use `"shared": "*"` — npm
links a package matching a workspace name regardless of range.

### 2. npm hoisted `expo@57` / `react-native@0.87` over the app's SDK 52
The root `package.json` duplicated `expo-asset`/`expo-constants`/etc. from the
`app` workspace. Those declare `"expo": "*"` peers, and npm 12 auto-installs
the **latest** peer at the root, producing two copies (52 in `app`, 57 at
root). **Fix:** delete the duplicate `expo-*` deps from the root manifest (the
`app` workspace already declares them). `npm ls expo react-native` should show
a single `52.0.49` / `0.76.9`.

### 3. Stale `package-lock.json` after manifest edits → "Invalid Version: "
If you edit `package.json` between `npm install`s (or wipe `node_modules` but
keep the lock), npm 12's arborist can crash with `TypeError: Invalid Version: `
during dedupe. **Fix:** `rm -rf node_modules */node_modules package-lock.json`
and reinstall fresh.

### 4. `import expo.core.ExpoModulesPackage;` — cannot find symbol
Generated `app/android/app/build/generated/autolinking/.../PackageList.java`
imports `expo.core.ExpoModulesPackage`, but the class ships as
`expo.modules.ExpoModulesPackage`, so `:app:compileDebugJavaWithJavac` fails.
This is an upstream Expo SDK 52/53 autolinking bug
(expo-modules-autolinking@2.0.8 `react-native-config` ignores the
`packageImportPath` key and falls back to the module's `namespace "expo.core"`).
**Fix (in repo):** `app/react-native.config.js` overrides the `expo` dep:
```js
module.exports = {
  dependencies: {
    expo: { platforms: { android: {
      n: 'import expo.modules.ExpoModulesPackage;',
      packageImportPath: 'import expo.modules.ExpoModulesPackage;',
    } } },
  },
};
```
(`n` is read by expo's autolinker, `packageImportPath` by the community CLI —
both produce the correct import.) **Do not** hand-add an
`expo/core/ExpoModulesPackage.java` stub under `app/android/` — it's a
gitignored generated dir and gets wiped by prebuild; the config override is the
durable fix.

### 5. Release app crashes: `ReferenceError: Property 'crypto' doesn't exist`
`app/src/App.tsx` called `crypto.randomUUID()` at module load. Hermes
(React Native 0.76) exposes no global `crypto`, so the bundle throws before
`AppRegistry.registerComponent` runs → `"main" has not been registered`.
**Fix (in repo):** a helper that uses `crypto.randomUUID()` when present and
otherwise falls back to `Date.now()`/`Math.random()` (no new dependency).
`shared/src/rollingCode.ts` already avoided `node:crypto`; watch for any other
`crypto`/`Buffer` use in RN-bundled code.

### 6. Emulator: `FATAL | Not enough space to create userdata partition`
The emulator's disk check is fixed at **~7.4 GB** and **ignores** both
`disk.dataPartition.size` in `~/.android/avd/shusseki.avd/config.ini` and the
`-partition-size` flag. **Fix:** actually free disk (get `/` under ~90%). On
this machine we cleared regenerable caches:
`~/.bun/install` (6.5G), `~/.gradle/caches` (3.9G), `~/.npm`, the pacman cache
(`yes | sudo pacman -Scc`, ~6.5G), plus removed the ghcup Haskell toolchain
and 101 orphaned packages. Root went 94% → 83% and the emulator booted.

### 7. Gradle: `Could not read workspace metadata .../metadata.bin`
Deleting `~/.gradle/caches` while a Gradle daemon has them open corrupts the
Kotlin accessor cache. **Fix:** `./gradlew --stop` first, then
`rm -rf ~/.gradle/caches`, then rebuild (the first build re-downloads the deps,
~2-4 GB).

### 8. `pkill` kills your own shell when launching/stopping the emulator
`pkill -f qemu-system` matches the *launching shell's* command line too (it
contains that string), silently killing the command before the emulator starts.
Use the exact process name or PID instead:
`pkill -x qemu-system-x86_64-headless` (headless) — killing by PID is safest.
Windowed builds run as `qemu-system-x86_64`.

### 9. Kotlin-only modules — remember ABI choices
The four `app/modules/expo-shusseki-*` are Kotlin/Swift; no `cpp/` → no NDK.

---

## Remaining knit-picks (fix when convenient, non-blocking)
- `npm run lint` fails today: there is no `biome.json`, and `biome check .`
  walks the gitignored `app/android/` build artifacts. Fix: add a
  `biome.json` that excludes `app/android/**` (and ideally `.expo/`).

Historical bun references remain in `todo.md`, `docs/adr/0005`'s update
addendum, and the Troubleshooting section above — those are records of the
migration, not current requirements. The toolchain itself (manifests,
tsconfig, scripts, `AGENTS.md`) has been bun-free since 2026-08
(`@types/bun` and the `"bun"` tsconfig entry are gone).

## Porting notes (non-Arch)
- **Debian/Ubuntu:** `apt install openjdk-21-jdk-headless`; KVM:
  `apt install qemu-kvm libvirt-daemon-system`.
- **Fedora:** `dnf install java-21-openjdk-devel`; KVM: `dnf install qemu-kvm`.
- Android SDK / AVD / Gradle / npm steps above are distro-agnostic.
