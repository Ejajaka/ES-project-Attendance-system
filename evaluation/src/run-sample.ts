import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  evaluateInstances,
  fuse,
  decide,
  roomCountError,
  type EvaluationSample,
  type EvalKey,
  type ClassificationMetrics,
} from "shared";

export interface Scenario {
  /** Per-device modality confidences + per-instance ground truth. */
  samples: EvaluationSample[];
  /** Manual headcount for room-level evaluation. */
  headcount: number;
}

/**
 * A small illustrative scenario: 4 people present, 1 not. It is constructed so
 * that fusing is strictly better than any single modality (one person is only
 * detectable via ultrasonic, another only via fused BLE+WiFi agreement).
 */
export function buildSampleScenario(): Scenario {
  const s = (
    ble: number,
    wifi: number,
    ultra: number,
    actualPresent: boolean,
  ): EvaluationSample => ({
    confidences: { ble, wifi, ultrasonic: ultra },
    actualPresent,
  });

  return {
    samples: [
      s(0.9, 0.9, 0.9, true), // strong everywhere
      s(0.9, 0.8, 0.1, true), // BLE+WiFi strong, ultrasonic weak
      s(0.2, 0.2, 0.9, true), // ultrasonic only — single modalities miss
      s(0.6, 0.6, 0.2, true), // moderate BLE+WiFi, fused crosses threshold
      s(0.1, 0.1, 0.05, false), // absent
    ],
    headcount: 4,
  };
}

export interface Comparison {
  metrics: Record<EvalKey, ClassificationMetrics>;
  predictedPresent: number;
  headcount: number;
  countError: number;
}

/** Run the comparative evaluation for one scenario. */
export function runComparison(scenario: Scenario): Comparison {
  const metrics = evaluateInstances(scenario.samples);
  const predictedPresent = scenario.samples.filter((sample) => {
    const fused = fuse(sample.confidences);
    return decide(fused, 0.5);
  }).length;
  return {
    metrics,
    predictedPresent,
    headcount: scenario.headcount,
    countError: roomCountError(predictedPresent, scenario.headcount),
  };
}

function fmt(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

/** Pretty-print the BLE/WiFi/Ultrasonic/Fused comparison. */
export function printComparison(c: Comparison): string {
  const rows: string[] = [];
  rows.push("Modality        Precision  Recall   F1       Accuracy");
  rows.push("------------------------------------------------------");
  for (const key of ["ble", "wifi", "ultrasonic", "fused"] as EvalKey[]) {
    const m = c.metrics[key]!;
    rows.push(
      `${key.padEnd(15)} ${fmt(m.precision).padStart(7)}  ${fmt(m.recall).padStart(7)}  ${fmt(m.f1).padStart(7)}  ${fmt(m.accuracy).padStart(7)}`,
    );
  }
  rows.push("");
  rows.push(
    `Room-level: predicted present=${c.predictedPresent}, headcount=${c.headcount}, count error=${c.countError}`,
  );
  return rows.join("\n");
}

// Allow running directly: `npm run run:sample`. This entry-point check also
// works on Node 20 (bun's `import.meta.main` is unavailable below Node 22.18).
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const scenario = buildSampleScenario();
  const comparison = runComparison(scenario);
  console.log(printComparison(comparison));
}
