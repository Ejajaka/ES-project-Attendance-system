import { Platform } from "react-native";

/**
 * HUD design tokens for the Shusseki "NERV console" look.
 *
 * The app targets a super-user / researcher, not a consumer, so the palette is
 * a dense, dark technical readout in the Neon Genesis Evangelion / NERV
 * console style: near-black navy fields, thin teal-blue rules, neon purple
 * (EVA-01) primary, lime (EVA-01 secondary) for healthy/online, amber for
 * warnings, red for faults. Everything else degrades to dim mono.
 *
 * Rule: screens never hardcode a hex/color/size — all repeated visual values
 * live here (see expo-design-system skill).
 */

/* Monospace face: Menlo on iOS, the platform mono on Android. */
export const MONO = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
})!;

export const colors = {
  /* Canvas */
  bg: "#05060b",
  bgRaised: "#080a12",
  panel: "#0b0f1a",
  panelAlt: "#101627",
  field: "#07090f",

  /* Rules & hierarchy */
  line: "#1c2742",
  lineStrong: "#26375f",

  /* Ink */
  text: "#dfe6f6",
  dim: "#8f9ab8",
  faint: "#55607f",

  /* EVA-01 purple (primary) */
  purple: "#a78bfa",
  purpleBright: "#c4b5fd",
  purpleDim: "#2e2a4d",

  /* EVA-01 lime (online / go) */
  green: "#a3e635",
  greenBright: "#d9f99d",
  greenDim: "#33421a",

  /* NERV amber (warn) */
  amber: "#fbbf24",
  amberDim: "#4a3510",

  /* Fault */
  red: "#f87171",
  redDim: "#4a1d1d",

  /* Data / raw */
  cyan: "#67e8f9",
  cyanDim: "#164e63",
} as const;

/** Typography ramp. `text.*` only — screens never set raw fontSize. */
export const text = {
  /* Big console title */
  hudTitle: {
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: 8,
    color: colors.text,
    fontFamily: MONO,
  },
  hudJapanese: {
    fontSize: 40,
    fontWeight: "700",
    color: colors.purple,
    letterSpacing: 10,
  },
  /* Subhead / tagline */
  hudSub: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 4,
    color: colors.dim,
    fontFamily: MONO,
  },
  /* Panel + section headers */
  section: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 2,
    color: colors.text,
    fontFamily: MONO,
  },
  /* Small field labels */
  label: {
    fontSize: 10,
    color: colors.dim,
    fontFamily: MONO,
    letterSpacing: 1,
  },
  /* Field values */
  value: {
    fontSize: 12,
    color: colors.text,
    fontFamily: MONO,
  },
  big: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.text,
    fontFamily: MONO,
  },
  glow: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.green,
    fontFamily: MONO,
    textShadowColor: colors.green,
    textShadowRadius: 8,
  },
  tiny: {
    fontSize: 9,
    color: colors.faint,
    fontFamily: MONO,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** All radiuses are sharp (HUD chrome); capsules only for pills. */
export const radius = {
  sm: 2,
  md: 3,
  full: 9999,
} as const;