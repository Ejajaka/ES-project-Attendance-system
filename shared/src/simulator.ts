import { generateTOTP } from "./rollingCode";
import type { DeviceReport } from "./types";

/**
 * Builds the report a real receiver would send, for single-phone demos and
 * tests. The rolling code is generated from the session secret exactly like
 * the transmitter's, then carried the same way the app carries it (inside the
 * BLE reading's `code` field).
 */

export interface SimulatedTransmitter {
  nodeId: string;
  ssid: string;
  rssi: number;
}

export interface SimulateReceiverInput {
  deviceId: string;
  roomId: string;
  sessionId: string;
  now: number;
  secret: Uint8Array;
  /** Live transmitter view; null simulates "no transmitter in range". */
  transmitter: SimulatedTransmitter | null;
  step?: number;
  digits?: number;
}

export function simulateReceiverReport(
  input: SimulateReceiverInput,
): DeviceReport {
  const { transmitter } = input;
  const base = {
    deviceId: input.deviceId,
    mode: "jushin" as const,
    roomId: input.roomId,
    sessionId: input.sessionId,
    timestamp: input.now,
  };

  if (!transmitter) {
    return {
      ...base,
      ble: { readings: [] },
      wifi: { connectedToSoshin: false, soshinRssi: null },
      ultrasonic: { received: false, valid: null, code: null, missReason: "no_signal" },
    };
  }

  const code = generateTOTP(input.secret, input.now, {
    step: input.step,
    digits: input.digits,
  });

  return {
    ...base,
    ble: {
      readings: [{ nodeId: transmitter.nodeId, rssi: transmitter.rssi, code }],
      ownInterface: { name: input.deviceId },
    },
    wifi: {
      ssid: transmitter.ssid,
      connectedToSoshin: true,
      soshinRssi: transmitter.rssi,
    },
    ultrasonic: {
      received: true,
      valid: true,
      code,
      snr: 9,
    },
  };
}
