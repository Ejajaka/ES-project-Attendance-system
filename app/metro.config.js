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

// Map the shadcn-style `@/` TS alias for Metro itself. Babel's
// module-resolver rewrites imports for the runtime, but Metro still has to
// resolve the module graph, and it does not read tsconfig `paths`.
const srcRoot = path.join(projectRoot, "src");
config.resolver.alias = {
  ...(config.resolver.alias ?? {}),
  "@": srcRoot,
};
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@": srcRoot,
};

// NativeWind compiles `app/global.css` (Tailwind) and serves it to the
// bundle. `inlineRem: 16` keeps `rem`-based Tailwind sizing truthful on native
// (required by react-native-reusables, whose classes assume rem = 16px).
const finalConfig = withNativeWind(config, {
  input: path.join(projectRoot, "global.css"),
  // Resolve relative to the app, not Metro's CWD (the monorepo root in release
  // bundling, which made it look for <repo>/tailwind.config).
  configPath: path.join(projectRoot, "tailwind.config.js"),
  inlineRem: 16,
});

// Resolve the `@/` TS alias at the Metro layer. Release bundling resolves the
// module graph before Babel's module-resolver rewrite, so shadcn-style imports
// (`@/components/ui/...`) otherwise fail. IMPORTANT: nativewind installs its
// own `resolveRequest` (it serves the compiled global.css as a virtual
// module), so chain to it instead of clobbering it.
const previousResolveRequest = finalConfig.resolver.resolveRequest;
finalConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = moduleName.startsWith("@/")
    ? path.join(srcRoot, moduleName.slice(2))
    : moduleName;
  if (previousResolveRequest) {
    return previousResolveRequest(context, target, platform);
  }
  return context.resolveRequest(context, target, platform);
};

module.exports = finalConfig;
