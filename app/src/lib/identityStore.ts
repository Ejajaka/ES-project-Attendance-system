import * as FileSystem from "expo-file-system";

/**
 * The student identity enrolled on this phone (roll + name), persisted so the
 * receiver only has to enter it once. It is bound to this device's biometric:
 * every engage must pass the device fingerprint check before attendance runs.
 *
 * Note: Android's BiometricPrompt verifies "the device owner", not a specific
 * finger — the OS does not expose which finger was used. If more than one
 * finger is enrolled on the phone, any of them satisfies the check.
 */
export interface StudentIdentity {
  studentId: string;
  studentName: string;
  /** When the identity was first enrolled (ms epoch). */
  enrolledAt: number;
}

const FILE = `${FileSystem.documentDirectory ?? ""}shusseki-identity.json`;

export async function loadIdentity(): Promise<StudentIdentity | null> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists || info.isDirectory) return null;
    const raw = await FileSystem.readAsStringAsync(FILE);
    const parsed = JSON.parse(raw) as Partial<StudentIdentity>;
    const studentId = parsed.studentId?.trim();
    const studentName = parsed.studentName?.trim();
    if (!studentId || !studentName) return null;
    return {
      studentId,
      studentName,
      enrolledAt: parsed.enrolledAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

export async function saveIdentity(identity: StudentIdentity): Promise<void> {
  await FileSystem.writeAsStringAsync(
    FILE,
    JSON.stringify({
      studentId: identity.studentId.trim(),
      studentName: identity.studentName.trim(),
      enrolledAt: identity.enrolledAt,
    }),
  );
}

export async function clearIdentity(): Promise<void> {
  try {
    await FileSystem.deleteAsync(FILE, { idempotent: true });
  } catch {
    // Nothing to clear / storage unavailable.
  }
}
