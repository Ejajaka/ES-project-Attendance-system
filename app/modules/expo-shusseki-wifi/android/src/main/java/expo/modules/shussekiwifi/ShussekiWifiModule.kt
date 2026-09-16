package expo.modules.shussekiwifi

import android.Manifest
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Soshin hosts a LocalOnlyHotspot; Jushin joins it (WifiNetworkSpecifier) and
 * reports WiFi RSSI. getRssi requires ACCESS_FINE_LOCATION + location services
 * enabled; hotspot + join additionally use NEARBY_WIFI_DEVICES (API 33+).
 */
class ShussekiWifiModule : Module() {
  private val context: Context
    get() = appContext.reactContext
      ?: throw IllegalStateException("React context unavailable")

  private var hotspotReservation: WifiManager.LocalOnlyHotspotReservation? = null

  // Tracks whether a specifier-requested network is currently usable, so
  // getObservation can report an honest connectedToSoshin.
  private var specifierAvailable = false
  private var requestedSsid: String? = null
  private val connectivity: ConnectivityManager
    get() = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  override fun definition() = ModuleDefinition {
    Name("ShussekiWifi")

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      // NEARBY_WIFI_DEVICES is API 33+; on older devices fine location suffices.
      val requested = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.NEARBY_WIFI_DEVICES,
        )
      } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        *requested,
      )
    }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      val requested = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.NEARBY_WIFI_DEVICES,
        )
      } else {
        arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      }
      Permissions.getPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        *requested,
      )
    }

    AsyncFunction("connectSoshin") { ssid: String, passphrase: String? ->
      connectToSoshin(ssid, passphrase)
    }

    AsyncFunction("getObservation") {
      getObservation()
    }

    AsyncFunction("startHotspot") { promise: Promise ->
      startHotspot(promise)
    }

    AsyncFunction("stopHotspot") {
      stopHotspot()
    }
  }

  private fun connectToSoshin(ssid: String, passphrase: String?): Boolean {
    requestedSsid = ssid
    specifierAvailable = false

    val specifierBuilder = WifiNetworkSpecifier.Builder().setSsid(ssid)
    if (!passphrase.isNullOrEmpty()) {
      specifierBuilder.setWpa2Passphrase(passphrase)
    }
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .setNetworkSpecifier(specifierBuilder.build())
      .build()

    // NOTE: we deliberately do NOT bindProcessToNetwork — reports must still
    // reach the fusion server over the internet/LAN, not only the local link.
    connectivity.requestNetwork(request, object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        specifierAvailable = true
      }

      override fun onLost(network: Network) {
        specifierAvailable = false
      }
    })
    return true
  }

  private fun getObservation(): Map<String, Any?> {
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      ?: return mapOf("connectedToSoshin" to false, "soshinRssi" to null, "ssid" to null, "bssid" to null)
    val info = wifi.connectionInfo
    val ssid = info?.ssid?.removeSurrounding("\"")
    val connected = specifierAvailable || (requestedSsid != null && ssid == requestedSsid)
    return mapOf(
      "connectedToSoshin" to connected,
      // Only report RSSI while associated with the transmitter: otherwise the
      // value belongs to some other network and would corrupt link stats.
      "soshinRssi" to (if (connected) info?.rssi else null),
      "ssid" to ssid,
      "bssid" to (if (connected) info?.bssid else null),
    )
  }

  @Suppress("DEPRECATION")
  private fun reservationSsid(r: WifiManager.LocalOnlyHotspotReservation): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      r.softApConfiguration.ssid
    } else {
      r.wifiConfiguration?.SSID?.removeSurrounding("\"")
    }

  @Suppress("DEPRECATION")
  private fun reservationPassphrase(r: WifiManager.LocalOnlyHotspotReservation): String? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      r.softApConfiguration.passphrase
    } else {
      r.wifiConfiguration?.preSharedKey
    }

  private fun startHotspot(promise: Promise) {
    // Idempotent: an Activity recreation can reset the JS side while this
    // module (process-scoped) still holds the reservation. Re-engaging must
    // reuse it rather than fail with "hotspot already running".
    hotspotReservation?.let { existing ->
      promise.resolve(
        mapOf(
          "ssid" to reservationSsid(existing),
          "passphrase" to reservationPassphrase(existing),
        ),
      )
      return
    }
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    if (wifi == null) {
      promise.reject(CodedException("E_NO_WIFI", "WifiManager unavailable", null))
      return
    }

    val callback = object : WifiManager.LocalOnlyHotspotCallback() {
      override fun onStarted(reservation: WifiManager.LocalOnlyHotspotReservation) {
        hotspotReservation = reservation
        promise.resolve(
          mapOf(
            "ssid" to reservationSsid(reservation),
            "passphrase" to reservationPassphrase(reservation),
          ),
        )
      }

      override fun onFailed(reason: Int) {
        hotspotReservation = null
        promise.reject(CodedException("E_HOTSPOT_FAILED", "LocalOnlyHotspot failed: $reason", null))
      }
    }

    try {
      // Single-arg startLocalOnlyHotspot was removed from SDK 34+ stubs; the
      // handler variant exists since API 27, so require that and fail loudly
      // on anything older rather than crashing with NoSuchMethodError.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
        promise.reject(
          CodedException("E_HOTSPOT_UNSUPPORTED", "LocalOnlyHotspot needs Android 8.1+", null),
        )
        return
      }
      wifi.startLocalOnlyHotspot(callback, Handler(Looper.getMainLooper()))
    } catch (e: Exception) {
      // SecurityException when location/nearby-devices permissions are missing.
      promise.reject(CodedException("E_HOTSPOT_DENIED", e.message, e))
    }
  }

  private fun stopHotspot() {
    hotspotReservation?.close()
    hotspotReservation = null
  }
}
