import type { Modality } from "./types";

/**
 * Combine per-modality confidences into a single fused presence probability.
 * See PLAN.md §2 — the research contribution is whether fusing beats any one
 * signal alone, so the combiner is pluggable and compared side by side.
 */

export type Combiner = "noisy-or" | "average" | "weighted";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface FuseOptions {
  combiner?: Combiner; // default "noisy-or"
  /** Weights for the "weighted" combiner (default 1 per modality). */
  weights?: Partial<Record<Modality, number>>;
}

/**
 * Fuse present modalities into [0,1].
 * - `noisy-or`: 1 - Π(1 - cᵢ) — any strong signal raises fused confidence.
 * - `average`: mean of present confidences.
 * - `weighted`: Σ wᵢcᵢ / Σ wᵢ.
 * Missing/NaN modalities are ignored.
 */
export function fuse(
  confidences: Partial<Record<Modality, number>>,
  opts: FuseOptions = {},
): number {
  const entries = (
    Object.entries(confidences) as [Modality, number][]
  ).filter(([, v]) => typeof v === "number" && !Number.isNaN(v))
    .map(([k, v]) => [k, clamp01(v)] as [Modality, number]);

  if (entries.length === 0) return 0;

  const combiner = opts.combiner ?? "noisy-or";
  const vals = entries.map(([, v]) => v);

  if (combiner === "average") {
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  if (combiner === "weighted") {
    const weights = opts.weights ?? {};
    let num = 0;
    let den = 0;
    for (const [k, v] of entries) {
      const w = weights[k] ?? 1;
      num += w * v;
      den += w;
    }
    return den === 0 ? 0 : num / den;
  }

  // noisy-or (default)
  const pNone = entries.reduce((acc, [, v]) => acc * (1 - v), 1);
  return clamp01(1 - pNone);
}

/** Threshold a confidence into a binary presence decision. */
export function decide(confidence: number, threshold = 0.5): boolean {
  return confidence >= threshold;
}
