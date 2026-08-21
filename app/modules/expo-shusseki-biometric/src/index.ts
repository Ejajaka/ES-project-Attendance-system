import { requireNativeModule } from "expo";

export interface NativeBiometricResult {
  performedAt: number;
  kind: "fingerprint" | "face";
  success: boolean;
}

const NativeBio = requireNativeModule("ShussekiBiometric");

/** On-device biometric check (supporting anti-spoofing, non-core). */
export async function bioPerform(
  kind: "fingerprint" | "face",
): Promise<NativeBiometricResult> {
  return NativeBio.perform(kind);
}
