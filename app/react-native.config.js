/**
 * Project-level react-native.config.js.
 *
 * Overrides the Android `packageImportPath` that auto-linkers generate for the
 * `expo` package. Without this override, Expo Autolinking's `react-native-config`
 * (expo-modules-autolinking) writes `import expo.core.ExpoModulesPackage;` into
 * the generated PackageList.java, but the class is actually generated as
 * `expo.modules.ExpoModulesPackage` — causing:
 *
 *   PackageList.java:14: error: cannot find symbol ... location: package expo.core
 *
 * The legacy `n` key is honored by expo-modules-autolinking's android resolver;
 * `packageImportPath` is honored by the React Native community CLI autolinker.
 * We provide both so the same result is produced regardless of which auto-linker
 * runs (default or EXPO_USE_COMMUNITY_AUTOLINKING=1).
 */
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          n: 'import expo.modules.ExpoModulesPackage;',
          packageImportPath: 'import expo.modules.ExpoModulesPackage;',
        },
      },
    },
  },
};
