/**
 * Plain-language role terms. The wire mode values stay `soshin`/`jushin`
 * (brand, and the report schema), but every surface an operator reads says
 * TRANSMITTER or RECEIVER first.
 */

export type Mode = "soshin" | "jushin";

export interface RoleTerms {
  /** Plain-language role. */
  en: "TRANSMITTER" | "RECEIVER";
  /** Japanese brand accent. */
  jp: string;
  /** Brand word retained. */
  brand: "SOSHIN" | "JUSHIN";
  /** Where the role physically runs. */
  where: string;
}

const TERMS: Record<Mode, RoleTerms> = {
  soshin: {
    en: "TRANSMITTER",
    jp: "送信",
    brand: "SOSHIN",
    where: "ROOM",
  },
  jushin: {
    en: "RECEIVER",
    jp: "受信",
    brand: "JUSHIN",
    where: "USER PHONE",
  },
};

export function roleTerms(mode: Mode): RoleTerms {
  return TERMS[mode];
}

/** e.g. "TRANSMITTER · SOSHIN" — used in room-monitor rows. */
export function roleLabel(mode: Mode): string {
  return `${TERMS[mode].en} · ${TERMS[mode].brand}`;
}
