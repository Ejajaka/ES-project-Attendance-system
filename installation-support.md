# Shusseki — installation & support (Arch Linux)

Everything needed to build the Android app and run the emulator on **Arch
Linux**. Written from a worked session on Arch `x86_64`; adjust paths/versions
to taste. Other distros: see the "porting notes" at the end.

> Short version: Node 20 + JDK 21 + Android SDK (API 35) + npm. The package
> managers on Arch default to **Node 26 / JDK 25**, which **break the Expo
> toolchain** — do not skip the Node/JDK pins.

## 1. Node 20 (Expo needs Node ≤ ~22; Node 26 fails)

Arch's `nodejs` is the "Current" (bleeding) line. Install a controllable LTS
with `n`:

```bash
npm install -g n          # npm ships with Node, so this works first
sudo n 20                 # installs v20 to /usr/local/n and symlinks /usr/local/bin/node
hash -r; node --version   # -> v20.x
```

`n` keeps the system Node 26 under `/usr/sbin` untouched; `/usr/local/bin`
wins the PATH. (Alternative: `sudo pacman -S nodejs-lts-iron`, which conflicts
with `nodejs` and replaces the default.)

## 2. JDK 21 (Gradle 8.10 / AGP need ≤ 21; JDK 25 is too new)

```bash
sudo pacman -S --needed jdk21-openjdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"     # export in ~/.zshrc too
java -version                            # -> 21.x
```

Full package set commonly needed: `jdk21-openjdk` (also implicitly gives
`jre-openjdk-headless`). Do **not** point Gradle at `java-25-openjdk`.

## 3. Android SDK (the new `android` CLI or manual)

Choose a root dir, e.g. `/opt/android-sdk`:

```bash
sudo mkdir -p /opt/android-sdk
# cmdline-tools first (the CLI that installs everything else):
#   download commandlinetools-linux-*.zip from https://developer.android.com/studio#command-line-tools-only
#   unzip to /opt/android-sdk/cmdline-tools/latest
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

**Fix ownership first** — the CLI writes a legacy XML into the SDK tree, and a
root-owned dir causes `java.nio.file.AccessDeniedException`:

```bash
sudo chown -R "$USER":"$USER" /opt/android-sdk      # required, or installs fail
```

Then install the SDK packages with the new CLI:

```bash
android sdk install "platform-tools"
android sdk install "platforms;android-35"          # compileSdk for the app
android sdk install "build-tools;35.0.0"
android sdk install "ndk;27.1.12297006"             # only if you build C++/codegen
android sdk install "emulator"
android sdk install "system-images;android-35;google_apis;x86_64"
```

Verify: `android sdk list` should show platform 35, build-tools, emulator.

> New CLI crashes may leave a report in `~/.android/cli/analytics/crash_reports/`;
> that's harmless.

## 4. Create an AVD (emulator "device")

```bash
echo no | /opt/android-sdk/cmdline-tools/latest/bin/avdmanager create avd \
  -n shusseki -k "system-images;android-35;google_apis;x86_64" -d pixel_5 --force
```

**KVM must work** for usable performance:

```bash
ls -l /dev/kvm      # should exist
sudo pacman -S --needed qemu-desktop libvirt dnsmasq  # qemu brings /dev/kvm setup
sudo usermod -aG kvm "$USER"   # add your user to the kvm group, then re-login
```

## 5. Run the emulator

**Windowed (you want to see the screen):**

```bash
export DISPLAY=${DISPLAY:-:0}     # X/XWayland
/opt/android-sdk/emulator/emulator -avd shusseki \
  -gpu swiftshader_indirect -no-audio -no-snapshot -no-metrics &
```

**Headless (CI / no display):**

```bash
/opt/android-sdk/emulator/emulator -avd shusseki \
  -no-window -gpu swiftshader_indirect -no-audio -no-snapshot -no-metrics &
```

Wait for boot, then the app is driven via adb:

```bash
adb wait-for-device
adb shell getprop sys.boot_completed   # until it prints "1"
adb install -r path/to/app-release.apk
adb shell am start -n com.shusseki.app/.MainActivity
adb logcat -d | grep ReactNativeJS
adb exec-out screencap -p > screen.png
```

### If the emulator won't boot (headless under automation)
- kill leftovers / stale locks:
  `pkill -9 -f qemu-system; pkill -9 -f emulator; rm -f ~/.android/avd/*.lock`
- confirm `/dev/kvm` permission; try `-gpu swiftshader_indirect` (software;
  reliable) instead of `-gpu host`.
- If the windowed Qt window throws `QXcbWindow … mapped window` errors on
  Wayland, run the emulator from a real terminal on the graphical session
  rather than a detached background job.

## 6. Gradle (optional but reliable)

Expo/RN's Gradle wrapper downloads Gradle itself; the wrapper's 10 s connect
timeout often fails on larger/redirected downloads:

```bash
# seed the exact distribution the wrapper wants:
curl -sL -o /tmp/gradle-8.10.2-all.zip https://services.gradle.org/distributions/gradle-8.10.2-all.zip
# copy into the hash dir the wrapper created (~/.gradle/wrapper/dists/gradle-8.10.2-all/<hash>/)
cp /tmp/gradle-8.10.2-all.zip ~/.gradle/wrapper/dists/gradle-8.10.2-all/*/gradle-8.10.2-all.zip
```

Proxies: Gradle wrapper connect failures usually show `SocketTimeoutException`
or `Connect timed out` — see `curl -sIL` for reachability.

## 7. Build the release APK

```bash
cd app            # the npm-based Expo project (see session.md / todo.md)
npm install
npx expo prebuild --platform android
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"
cd android && ./gradlew assembleRelease
ls app/build/outputs/apk/release/app-release.apk
```

Hazards seen on Arch:
- **Node/Bun running the Expo CLI** → use Node 20 (`node_node_modules/expo/bin/cli …`).
- **`expo-modules-core` version skew** → let **npm** resolve it (a bun-installed
  project can float `expo-modules-core` to a version that mismatches Expo, which
  crashes with `Cannot read property 'EventEmitter' of undefined`).
- **Symlinked workspace `shared` dep not resolving in Metro** → add it to
  `metro.config.js` `watchFolders` + `resolver.nodeModulesPaths`.

## Porting notes (non-Arch)
- **Debian/Ubuntu:** `apt install openjdk-21-jdk-headless`; Node via `n`;
  KVM: `apt install qemu-kvm libvirt-daemon-system`.
- **Fedora:** `dnf install java-21-openjdk-devel`; KVM: `dnf install qemu-kvm`.
- Android SDK / AVD / Gradle / npm steps above are distro-agnostic.