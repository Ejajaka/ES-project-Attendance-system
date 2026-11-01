import { requireNativeModule } from "expo";

export interface NativeUltrasonicObservation {
  received: boolean;
  /** null = a tone was heard but could not be decoded. */
  valid: boolean | null;
  code: string | null;
  snr: number | null;
  /** Why a signal was missed: service killed vs no signal vs decode failure. */
  missReason: "none" | "service_killed" | "no_signal" | "decode_failed" | null;
  /** Matched-filter score (0..~1) — mean on-fraction across both stamp tones. */
  ratio?: number;
  /** Total energy in the observed band over the window — mic-health signal. */
  energy?: number;
}

const NativeUltra = requireNativeModule("ShussekiUltrasonic");

/** Soshin: emit the rolling-code tone over the speaker. */
export async function ultraTransmit(code: string): Promise<void> {
  return NativeUltra.transmit(code);
}

/** Jushin: listen once and return a decoded observation. */
export async function ultraListen(timeoutMs = 3000): Promise<NativeUltrasonicObservation> {
  return NativeUltra.listen(timeoutMs);
}

export async function ultraStartListener(): Promise<void> {
  return NativeUltra.startListener();
}

export async function ultraStopListener(): Promise<void> {
  return NativeUltra.stopListener();
}

/** Same-device concurrent transmit+record presence self-test. */
export async function ultraLoopback(timeoutMs = 3000): Promise<NativeUltrasonicObservation> {
  return NativeUltra.loopback(timeoutMs);
}

/** Shape of the bundle resolved by expo-modules-core permission requests. */
export interface NativePermissionResponse {
  status: "granted" | "denied" | "undetermined";
  granted: boolean;
  canAskAgain: boolean;
  expires: string;
}

export async function ultraRequestPermissionsAsync(): Promise<NativePermissionResponse> {
  return NativeUltra.requestPermissionsAsync();
}

export async function ultraGetPermissionsAsync(): Promise<NativePermissionResponse> {
  return NativeUltra.getPermissionsAsync();
}
