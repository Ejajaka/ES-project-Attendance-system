import * as FileSystem from "expo-file-system";
import { randomIdPrefix } from "../identity";

/** The small text file (in the document directory) that carries the device id across restarts. */
const ID_FILE = `${FileSystem.documentDirectory ?? ""}shusseki-device-id.txt`;

/**
 * The device's report identity, persisted so app restarts don't mint a new
 * one. Reads the id file from the document directory; when missing or
 * unreadable, mints `phone-${randomIdPrefix()}`, writes it for next time, and
 * returns it. Never throws — a fresh id each launch is better than a crash.
 */
export async function loadPersistentDeviceId(): Promise<string> {
  let fresh = `phone-${randomIdPrefix()}`;
  try {
    const info = await FileSystem.getInfoAsync(ID_FILE);
    if (info.exists && !info.isDirectory) {
      const stored = (await FileSystem.readAsStringAsync(ID_FILE)).trim();
      if (stored) return stored;
    }
  } catch {
    // Fall through: treat any read failure as "no id yet".
  }
  try {
    await FileSystem.writeAsStringAsync(ID_FILE, fresh);
  } catch {
    // Storage unavailable — run with the in-memory id, same as before.
  }
  return fresh;
}
