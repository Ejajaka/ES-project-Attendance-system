import ExpoModulesCore
import SystemConfiguration.CaptiveNetwork
import CoreLocation

/**
 * Jushin connects to the Soshin hotspot and reports WiFi RSSI.
 * RSSI is not directly available through public iOS APIs; this scaffold returns
 * the current SSID (requires the entitlements + location) and leaves RSSI as
 * null until a NEHotspotHelper / CTCarrier approach is adopted. Verify on device.
 */
class ShussekiWifiModule: Module {
  func definition() -> ModuleDefinition {
    Name("ShussekiWifi")

    AsyncFunction("connectSoshin") { (ssid: String) -> Bool in
      // iOS does not permit programmatic Wi-Fi association from a third-party
      // app. The user joins the Soshin hotspot manually; this returns true to
      // signal the intent was acknowledged.
      true
    }

    AsyncFunction("getObservation") -> [String: Any?] {
      let ssid = currentSsid()
      return [
        "connectedToSoshin": ssid != nil,
        "soshinRssi": nil,
        "ssid": ssid,
        "bssid": nil,
      ]
    }
  }

  private func currentSsid() -> String? {
    guard let interfaces = CNCopySupportedInterfaces() as? [String] else { return nil }
    for iface in interfaces {
      if let info = CNCopyCurrentNetworkInfo(iface as CFString) as? [String: Any] {
        return info[kCNNetworkInfoKeySSID as String] as? String
      }
    }
    return nil
  }
}
