import ExpoModulesCore
import CoreBluetooth

/**
 * Soshin advertises a room beacon; Jushin scans for node readings.
 * Requires NSBluetooth* usage descriptions (in app.json). Build + behavior
 * must be verified on a real device — CoreBluetooth requires a provisioned app.
 */
class ShussekiBleModule: Module {
  private var peripheralManager: CBPeripheralManager?
  private var centralManager: CBCentralManager?
  private var discovered: [(nodeId: String, rssi: Int)] = []
  private var scanContinuation: CheckedContinuation<[[String: Any]], Error>?

  func definition() -> ModuleDefinition {
    Name("ShussekiBle")

    AsyncFunction("advertise") { (roomId: String, nodeId: String) in
      try self.startAdvertising(roomId: roomId, nodeId: nodeId)
    }

    AsyncFunction("stopAdvertise") {
      try self.stopAdvertising()
    }

    AsyncFunction("scanOnce") { (timeoutMs: Double) -> [[String: Any]] in
      try await self.scanOnce(timeoutMs: timeoutMs)
    }
  }

  private let shussekiServiceUUID = CBUUID(string: "9E5A1E00-1234-5678-1234-56789ABCDEF0")

  private func startAdvertising(roomId: String, nodeId: String) throws {
    peripheralManager = CBPeripheralManager(delegate: self, queue: nil)
    guard let pm = peripheralManager else { throw BleError.unavailable }
    let payload = "\(roomId)|\(nodeId)".data(using: .utf8) ?? Data()
    let characteristic = CBMutableCharacteristic(
      type: CBUUID(string: "9E5A1E01-1234-5678-1234-56789ABCDEF0"),
      properties: [.read],
      value: payload,
      permissions: [.readable]
    )
    let service = CBMutableService(type: shussekiServiceUUID, primary: true)
    service.characteristics = [characteristic]
    pm.add(service)
    pm.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [shussekiServiceUUID],
      CBAdvertisementDataLocalNameKey: nodeId,
    ])
  }

  private func stopAdvertising() throws {
    peripheralManager?.stopAdvertising()
    peripheralManager = nil
  }

  private func scanOnce(timeoutMs: Double) async throws -> [[String: Any]] {
    discovered.removeAll()
    return try await withCheckedThrowingContinuation { continuation in
      self.scanContinuation = continuation
      centralManager = CBCentralManager(delegate: self, queue: nil)
      centralManager?.scanForPeripherals(withServices: nil, options: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + timeoutMs / 1000.0) {
        self.centralManager?.stopScan()
        let result = self.discovered.map { ["nodeId": $0.nodeId, "rssi": $0.rssi] }
        self.scanContinuation?.resume(returning: result)
        self.scanContinuation = nil
      }
    }
  }
}

extension ShussekiBleModule: CBCentralManagerDelegate, CBPeripheralManagerDelegate {
  func centralManagerDidUpdateState(_ central: CBCentralManager) {}
  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {}

  func centralManager(_ central: CBCentralManager,
                      didDiscover peripheral: CBPeripheral,
                      advertisementData: [String: Any],
                      rssi RSSI: NSNumber) {
    let id = peripheral.identifier.uuidString
    discovered.append((nodeId: id, rssi: RSSI.intValue))
  }
}

enum BleError: Error {
  case unavailable
}
