package expo.modules.shussekiwifi

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Jushin connects to the Soshin hotspot and reports WiFi RSSI.
 * getRssi requires ACCESS_FINE_LOCATION + location services enabled (declared in
 * app.json). Build + behavior must be verified on a device.
 */
class ShussekiWifiModule : Module() {
  private val context: Context
    get() = appContext.reactContext
      ?: throw IllegalStateException("React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("ShussekiWifi")

    AsyncFunction("connectSoshin") { ssid: String ->
      connectToSoshin(ssid)
    }

    AsyncFunction("getObservation") {
      getObservation()
    }
  }

  private fun connectToSoshin(ssid: String): Boolean {
    val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val specifier = WifiNetworkSpecifier.Builder()
      .setSsid(ssid)
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .setNetworkSpecifier(specifier)
      .build()
    connectivity.requestNetwork(request, object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        connectivity.bindProcessToNetwork(network)
      }
    })
    return true
  }

  private fun getObservation(): Map<String, Any?> {
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      ?: return mapOf("connectedToSoshin" to false, "soshinRssi" to null, "ssid" to null, "bssid" to null)
    val info = wifi.connectionInfo
    val ssid = info?.ssid?.trim('"')
    return mapOf(
      "connectedToSoshin" to true,
      "soshinRssi" to (info?.rssi ?: -100),
      "ssid" to ssid,
      "bssid" to (info?.bssid ?: null),
    )
  }
}
