import type { LinkState, LinkSummary, Modality, ModalityLink } from "shared";

/**
 * Console rendering helpers for link summaries. Kept pure so both the
 * transmitter's room monitor and the receiver's link plate show identical
 * state glyphs.
 */

const GLYPHS: Record<LinkState, string> = {
  connected: "●",
  degraded: "◐",
  lost: "○",
};

const LETTERS: Record<Modality, string> = {
  ble: "B",
  wifi: "W",
  ultrasonic: "U",
};

const ORDER: Modality[] = ["ble", "wifi", "ultrasonic"];

export function linkGlyph(state: LinkState): string {
  return GLYPHS[state];
}

export function linkStateLabel(state: LinkState): string {
  return state.toUpperCase();
}

/** "B● W◐ U○" — channels not reported show as dashes. */
export function linkChips(link?: LinkSummary): string {
  const byModality = new Map<Modality, ModalityLink>(
    (link?.modalities ?? []).map((m) => [m.modality, m]),
  );
  return ORDER.map((modality) => {
    const m = byModality.get(modality);
    return `${LETTERS[modality]}${m ? linkGlyph(m.state) : "–"}`;
  }).join(" ");
}

/** Compact age: 5s / 3m / 2h. Never negative. */
export function formatAge(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

const MODALITY_LABELS: Record<Modality, string> = {
  ble: "BLUETOOTH",
  wifi: "WIFI",
  ultrasonic: "ULTRASONIC",
};

/** Plain-language channel name for console rows. */
export function modalityLabel(modality: Modality): string {
  return MODALITY_LABELS[modality];
}
