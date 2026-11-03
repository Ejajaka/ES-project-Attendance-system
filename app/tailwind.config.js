/** @type {import('tailwindcss').Config} */
const path = require("path");

// Absolute, forward-slash glob: the release bundler's CWD is the monorepo root,
// and fast-glob does not match Windows backslash paths.
const contentGlob = path
  .join(__dirname, "src", "**", "*.{ts,tsx}")
  .replace(/\\/g, "/");

module.exports = {
  content: [contentGlob],
  presets: [require("nativewind/preset")],
  darkMode: "class", // dark-first app; the `dark` class is applied in App.tsx
  theme: {
    container: {
      center: true,
      padding: "2rem",
    },
    extend: {
      // Concrete dark-palette values (the shadcn `.dark` tokens). NativeWind's
      // native runtime does not reliably resolve `hsl(var(--token))`, which
      // left the release UI unstyled/white.
      colors: {
        border: "#262626",
        input: "#262626",
        ring: "#d4d4d4",
        background: "#0a0a0a",
        foreground: "#fafafa",
        primary: {
          DEFAULT: "#fafafa",
          foreground: "#171717",
        },
        secondary: {
          DEFAULT: "#262626",
          foreground: "#fafafa",
        },
        destructive: {
          DEFAULT: "#7f1d1d",
          foreground: "#fafafa",
        },
        muted: {
          DEFAULT: "#262626",
          foreground: "#a3a3a3",
        },
        accent: {
          DEFAULT: "#262626",
          foreground: "#fafafa",
        },
        popover: {
          DEFAULT: "#0a0a0a",
          foreground: "#fafafa",
        },
        card: {
          DEFAULT: "#0a0a0a",
          foreground: "#fafafa",
        },
      },
      borderRadius: {
        lg: "0.5rem",
        md: "0.375rem",
        sm: "0.25rem",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
