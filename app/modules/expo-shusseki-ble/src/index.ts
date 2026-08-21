import { requireNativeModule } from "expo";

export interface NativeBleReading {
  nodeId: string;
  rssi: number;
}

const NativeBle = requireNativeModule("ShussekiBle");

/** Soshin: advertise a room beacon identifying this node. */
export async function bleAdvertise(roomId: string, nodeId: string): Promise<void> {
  return NativeBle.advertise(roomId, nodeId);
}

export async function bleStopAdvertise(): Promise<void> {
  return NativeBle.stopAdvertise();
}

/** Jushin: scan once and return the node readings currently visible. */
export async function bleScanOnce(timeoutMs = 2000): Promise<NativeBleReading[]> {
  return NativeBle.scanOnce(timeoutMs);
}
