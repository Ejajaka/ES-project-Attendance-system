// The release bundler (gradle `export:embed`) runs at the monorepo root, so it
// loads Babel from here. Delegate to the app's config so `nativewind/babel`,
// the nativewind JSX import source, and the `@/` module-resolver alias apply.
module.exports = require("./app/babel.config.js");
