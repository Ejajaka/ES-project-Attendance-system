// NativeWind's Tailwind CLI child runs with CWD = the monorepo root (where the
// release bundler runs) and resolves `tailwind.config.js` from there. Delegate
// to the app's config so the correct `content` glob + shadcn palette are used.
module.exports = require("./app/tailwind.config.js");
