// Metro config for the Expo app inside an npm-workspaces monorepo.
//
// Metro's default resolver only walks plain `node_modules` dirs. With npm
// workspaces, the app's dependencies (expo, react-native, ...) and the `shared`
// workspace package are hoisted to the repo root (`../node_modules`), so we
// teach Metro about the workspace root and both node_modules paths. This powers
// both `expo start` and `expo export:embed` (release bundling).
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = Array.from(
  new Set([workspaceRoot, ...(config.watchFolders ?? [])]),
);
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(workspaceRoot, "node_modules"),
];
config.resolver.unstable_enableSymlinks = true;

// NativeWind compiles `app/global.css` (Tailwind) and serves it to the
// bundle. `inlineRem: 16` keeps `rem`-based Tailwind sizing truthful on native
// (required by react-native-reusables, whose classes assume rem = 16px).
module.exports = withNativeWind(config, { input: "./global.css", inlineRem: 16 });
