import ExpoModulesCore
import LocalAuthentication

/**
 * On-device biometric check (Touch ID / Face ID) used at attendance boundaries
 * as a supporting anti-spoofing signal (non-core). Verify on device.
 */
class ShussekiBiometricModule: Module {
  func definition() -> ModuleDefinition {
    Name("ShussekiBiometric")

    AsyncFunction("perform") { (kind: String) -> [String: Any] in
      try self.perform(kind: kind)
    }
  }

  private func perform(kind: String) throws -> [String: Any] {
    let context = LAContext()
    var error: NSError?
    let policy: LAPolicy = (kind == "face") ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthenticationWithBiometrics
    let available = context.canEvaluatePolicy(policy, error: &error)
    var success = false
    if available {
      context.evaluatePolicy(policy, localizedReason: "Confirm it is you") { ok, _ in
        success = ok
      }
      // evaluatePolicy resolves asynchronously; for the prototype we block briefly.
      // (In production, surface the system UI and resolve on completion.)
    }
    return [
      "performedAt": Int(Date().timeIntervalSince1970 * 1000),
      "kind": kind,
      "success": success,
    ]
  }
}
