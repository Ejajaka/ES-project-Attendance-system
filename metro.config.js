// Root-level Metro config for the npm-workspaces monorepo.
//
// `expo export:embed` (release bundling via gradle) discovers the project
// root as this directory, so the app's own `app/metro.config.js` (which sets
// projectRoot = <app>) is delegated to here. Without this, Metro resolves the
// entry file `./src/main.tsx` against the monorepo root and fails.
module.exports = require("./app/metro.config.js");