// Metro config for the Expo app inside a bun-workspaces monorepo.
//
// bun hoists transitive deps into `node_modules/.bun/<pkg>@<ver>/node_modules`,
// which Metro's default resolver (which only walks plain `node_modules` dirs)
// can't see. Teaching Metro about those dirs makes both `expo start` and
// `expo export:embed` (release bundling) resolve every package correctly.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "..");
const bunCache = path.join(workspaceRoot, "node_modules", ".bun");

const nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(workspaceRoot, "node_modules"),
];

if (fs.existsSync(bunCache)) {
  for (const entry of fs.readdirSync(bunCache)) {
    const nested = path.join(bunCache, entry, "node_modules");
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
      nodeModulesPaths.push(nested);
    }
  }
}

const config = getDefaultConfig(projectRoot);
config.watchFolders = Array.from(
  new Set([workspaceRoot, ...(config.watchFolders ?? [])]),
);
config.resolver.nodeModulesPaths = nodeModulesPaths;
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
