/**
 * NERV CRT-console design tokens for Shusseki.
 *
 * The look is the Neon Genesis Evangelion tech style, rendered as a 1990s
 * CRT terminal:
 *
 *  1. PURE BLACK FIELD — background is #000000; surfaces are barely-lit
 *     blacks separated by tone-tinted edges and dither, never grey rules.
 *  2. NEON CRT SIGNALS — monochromatic ink + saturated neon accents (EVA-01
 *     purple, toxic green, signal amber, crimson, data cyan). Flat plates.
 *  3. PIXEL-TERMINAL TYPE — one voice: Departure Mono (OFL), the lo-fi
 *     monospaced pixel face, at multiples of its native 11px grid.
 *  4. DITHER OVER RULES — texture = unicode shade-block dither bands (▓▒░)
 *     + scanlines, the way a CRT renders gradients.
 *  5. SUBTLE BLOOM — `boxShadow` halos + low-opacity ambient washes
 *     (BloomField) tint the black field subconsciously.
 *  6. ALERTS ARE THE UI — state changes slam full-screen interjection
 *     popups ("PATTERN GREEN", "EMERGENCY").
 *  7. LINE-BASED INTERFACE — colour-blocked panels with corner crop marks,
 *     flat meters with tick marks. The line, not the pixel, is the unit.
 *  8. BIOMACHINE FLAVOR — per-modality diagnostics read as "SYNC RATE", the
 *     fused confidence is the AT-FIELD, devices are UNITS.
 *  9. STATIC STATUS — lamps never blink. Motion only on press.
 *
 * Rule: screens never hardcode a hex/color/size — all repeated visual values
 * live here (see expo-design-system skill).
 */

/* The whole console speaks one pixel-mono voice: Departure Mono (OFL, Helena
 * Zhang) — a lo-fi terminal face with a late-90s pixel vibe. Bundled via
 * expo-font, loaded as `DepartureMono` in App.tsx. Pixel-perfect sizes are
 * multiples of 11px (the face's native grid). */
export const DEPARTURE = "DepartureMono";

/* Alias retained for readout text. */
export const MONO = "DepartureMono";

export const colors = {
  /* Pure black field */
  bg: "#000000",
  bgRaised: "#050507",
  panel: "#07070c",
  panelAlt: "#0b0b14",
  field: "#030304",

  /* Rules — white with a whisper of alpha (lines, not fills) */
  line: "rgba(255,255,255,0.14)",
  lineStrong: "rgba(255,255,255,0.30)",

  /* Ink — monochromatic base */
  text: "#f2f4ff",
  dim: "#9aa3bf",
  faint: "#5a6278",

  /* EVA-01 purple (primary unit identity) — neon CRT violet */
  purple: "#c77dff",
  purpleBright: "#e0aaff",
  purpleDim: "rgba(199,125,255,0.28)",

  /* EVA-01 toxic green (healthy / present) — neon phosphor */
  green: "#39ff8b",
  greenBright: "#b6ffd9",
  greenDim: "rgba(57,255,139,0.28)",

  /* Signal amber (warn — NERV control-room amber) */
  amber: "#ffb000",
  amberDim: "rgba(255,176,0,0.28)",

  /* Crimson (fault — blood red) */
  red: "#ff3b5c",
  redBright: "#ff8fa3",
  redDim: "rgba(255,59,92,0.28)",

  /* Data / raw readings — CRT cyan */
  cyan: "#3ef2ff",
  cyanDim: "rgba(62,242,255,0.28)",
} as const;

/** Subtle neon halo — the only "glow" in the system. Feeble by design. */
export function bloom(tone: string, alpha = 0.35, blur = 16): string {
  return `0 0 ${blur}px ${tone}`;
}

/** Typography ramp. `text.*` only — screens never set raw fontSize. */
export const text = {
  /* Big console title */
  hudTitle: {
    fontSize: 33,
    letterSpacing: 1,
    color: colors.text,
    fontFamily: DEPARTURE,
  },
  hudJapanese: {
    fontSize: 44,
    fontWeight: "800",
    color: colors.purple,
    letterSpacing: 8,
    textShadowColor: colors.purple,
    textShadowRadius: 14,
  },
  /* Subhead / tagline */
  hudSub: {
    fontSize: 11,
    letterSpacing: 2,
    color: colors.dim,
    fontFamily: DEPARTURE,
  },
  /* Panel + section headers */
  section: {
    fontSize: 11,
    letterSpacing: 1,
    color: colors.text,
    fontFamily: DEPARTURE,
  },
  /* Small field labels */
  label: {
    fontSize: 11,
    color: colors.dim,
    fontFamily: DEPARTURE,
    letterSpacing: 1,
  },
  /* Field values */
  value: {
    fontSize: 11,
    color: colors.text,
    fontFamily: DEPARTURE,
  },
  big: {
    fontSize: 22,
    color: colors.text,
    fontFamily: DEPARTURE,
  },
  /* Massive block-letter status — the "EMERGENCY" screen. Departure Mono at
   * 3× its native 11px grid: chunky pixels, no synthetic bolding. */
  interject: {
    fontSize: 33,
    fontFamily: DEPARTURE,
    color: colors.text,
    letterSpacing: 1,
  },
  interjectSub: {
    fontSize: 11,
    fontFamily: DEPARTURE,
    color: colors.dim,
    letterSpacing: 1,
  },
  tiny: {
    fontSize: 11,
    color: colors.faint,
    fontFamily: DEPARTURE,
    letterSpacing: 1,
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

/** Sharp geometry — NERV chrome has no friendly rounding. */
export const radius = {
  sm: 0,
  md: 2,
  full: 9999, // only for ambient bloom blobs
} as const;