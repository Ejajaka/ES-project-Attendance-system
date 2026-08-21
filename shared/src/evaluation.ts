import { fuse, decide, type Combiner } from "./fusion";
import type { Modality } from "./types";

/**
 * Evaluation math for the comparative study (PLAN.md §2): each modality and the
 * fused result are scored against ground truth — both per-instance (when
 * identity linkage exists) and room-level (headcount).
 */

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function confusion(
  predicted: boolean[],
  actual: boolean[],
): Confusion {
  if (predicted.length !== actual.length) {
    throw new Error("predicted and actual length mismatch");
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < predicted.length; i++) {
    const p = predicted[i]!;
    const a = actual[i]!;
    if (p && a) tp++;
    else if (p && !a) fp++;
    else if (!p && a) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

export interface ClassificationMetrics {
  precision: number;
  recall: number;
  accuracy: number;
  f1: number;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export function classificationMetrics(c: Confusion): ClassificationMetrics {
  const support = c.tp + c.fp + c.fn + c.tn;
  const precision = c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
  const accuracy = support === 0 ? 0 : (c.tp + c.tn) / support;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, accuracy, f1, support, tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn };
}

/** Room-level absolute count error (primary headcount metric). */
export function roomCountError(
  predictedPresent: number,
  actualHeadcount: number,
): number {
  return Math.abs(predictedPresent - actualHeadcount);
}

export interface EvaluationSample {
  /** Per-modality confidence for one device/instance at one moment. */
  confidences: Partial<Record<Modality, number>>;
  /** Per-instance ground truth (requires identity linkage; deferred for v1). */
  actualPresent: boolean;
}

export type EvalKey = Modality | "fused";

export interface EvaluateOptions {
  threshold?: number; // default 0.5
  combiner?: Combiner; // default "noisy-or"
  weights?: Partial<Record<Modality, number>>;
}

/**
 * Score BLE-only, WiFi-only, Ultrasonic-only, and Fused against per-instance
 * ground truth. A missing modality reading is treated as "not detected".
 */
export function evaluateInstances(
  samples: EvaluationSample[],
  opts: EvaluateOptions = {},
): Record<EvalKey, ClassificationMetrics> {
  const threshold = opts.threshold ?? 0.5;
  const modalities: Modality[] = ["ble", "wifi", "ultrasonic"];
  const predicted: Record<EvalKey, boolean[]> = {
    ble: [],
    wifi: [],
    ultrasonic: [],
    fused: [],
  };
  const actual: boolean[] = [];

  for (const s of samples) {
    actual.push(s.actualPresent);
    for (const m of modalities) {
      const conf = s.confidences[m] ?? 0;
      predicted[m].push(decide(conf, threshold));
    }
    const fusedConf = fuse(s.confidences, {
      combiner: opts.combiner,
      weights: opts.weights,
    });
    predicted.fused.push(decide(fusedConf, threshold));
  }

  return {
    ble: classificationMetrics(confusion(predicted.ble, actual)),
    wifi: classificationMetrics(confusion(predicted.wifi, actual)),
    ultrasonic: classificationMetrics(confusion(predicted.ultrasonic, actual)),
    fused: classificationMetrics(confusion(predicted.fused, actual)),
  };
}
