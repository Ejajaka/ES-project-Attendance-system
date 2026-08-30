import { requireNativeModule } from "expo";

export interface NativeBleReading {
  nodeId: string;
  rssi: number;
  /** Rolling code advertised by the Soshin ("" if not present). */
  code?: string;
}

export interface NativeAdvertiseResult {
  /** True once the AdvertiseCallback reports onStartSuccess. */
  started: boolean;
  /** AdvertiseCallback error code (null on success). See BluetoothLeAdvertiser
   * ADVERTISE_FAILED_* constants: 1=DATA_TOO_LARGE, 2=TOO_MANY_ADVERTISERS,
   * 3=ALREADY_STARTED, 4=FEATURE_UNSUPPORTED, 5=INTERNAL_ERROR. */
  errorCode: number | null;
}

const NativeBle = requireNativeModule("ShussekiBle");

/** Shape of the bundle resolved by expo-modules-core permission requests. */
export interface NativePermissionResponse {
  status: "granted" | "denied" | "undetermined";
  granted: boolean;
  canAskAgain: boolean;
  expires: string;
}

/** Soshin: advertise a room beacon identifying this node (+ optional rolling code). */
export async function bleAdvertise(
  roomId: string,
  nodeId: string,
  code?: string,
): Promise<NativeAdvertiseResult> {
  return NativeBle.advertise(roomId, nodeId, code ?? null);
}

export async function bleStopAdvertise(): Promise<void> {
  return NativeBle.stopAdvertise();
}

/** Jushin: scan once and return the node readings currently visible. */
export async function bleScanOnce(timeoutMs = 2000): Promise<NativeBleReading[]> {
  return NativeBle.scanOnce(timeoutMs);
}

export async function bleRequestPermissionsAsync(): Promise<NativePermissionResponse> {
  return NativeBle.requestPermissionsAsync();
}

export async function bleGetPermissionsAsync(): Promise<NativePermissionResponse> {
  return NativeBle.getPermissionsAsync();
}

export interface NativeBleState {
  enabled: boolean;
  adapterAvailable: boolean;
}

export async function bleGetState(): Promise<NativeBleState> {
  return NativeBle.getState();
}

/** Best-effort power-on: turns BT on, or prompts the user if consent is needed. */
export async function bleEnsureEnabled(): Promise<boolean> {
  return NativeBle.ensureEnabled();
}
