// babel-preset-expo (SDK 52) applies the react-native-reanimated plugin for us;
// NativeWind only needs its own preset on top, with the JSX source set to
// `nativewind` so `className` props on RN primitives are transformed.
// module-resolver maps the shadcn-style `@/` imports used by the
// react-native-reusables components (Metro does not read tsconfig paths).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          alias: {
            "@": "./src",
          },
        },
      ],
    ],
  };
};
