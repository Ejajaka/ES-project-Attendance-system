import { requireNativeModule } from "expo";

export interface NativeUltrasonicObservation {
  received: boolean;
  /** null = a tone was heard but could not be decoded. */
  valid: boolean | null;
  code: string | null;
  snr: number | null;
  /** Why a signal was missed: service killed vs no signal vs decode failure. */
  missReason: "none" | "service_killed" | "no_signal" | "decode_failed" | null;
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
