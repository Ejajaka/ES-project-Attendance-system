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
 * Jushin joins the fixed open `atlas` network (ESP32 room-node softAP) with a
 * WifiNetworkSpecifier and reports the AP's RSSI. No passphrase: the specifier
 * is SSID-only, which is how Android targets an open network.
 *
 * getRssi requires ACCESS_FINE_LOCATION + location services enabled; hotspot +
 * join additionally use NEARBY_WIFI_DEVICES (API 33+).
 */
class ShussekiWifiModule : Module() {
  private val context: Context
    get() = appContext.reactContext
      ?: throw IllegalStateException("React context unavailable")

  private var hotspotReservation: WifiManager.LocalOnlyHotspotReservation? = null

  // Tracks whether a specifier-requested network is currently usable, so
  // getObservation can report an honest connectedToSoshin.
  private var specifierAvailable = false
  /** The specifier-granted network; used to pin app traffic into the room AP. */
  private var specifierNetwork: Network? = null
  private var requestedSsid: String? = null
  private var scannedBssid: String? = null
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

  /**
   * A WifiNetworkSpecifier request is one-shot: if the AP is unreachable during
   * the attempt (node rebooted, out of earshot for a moment) every later tick
   * still deserves a join attempt. Keep re-requesting while the SSID is wanted
   * and the specifier network has not come up.
   */
  private val joinRetryHandler = Handler(Looper.getMainLooper())
  private var joinRetryRunnable: Runnable? = null
  private var specifierCallback: ConnectivityManager.NetworkCallback? = null

  private fun connectToSoshin(ssid: String, passphrase: String?): Boolean {
    requestedSsid = ssid
    specifierAvailable = false
    // Re-engaging while a previous room network is still bound: release the
    // bind first, or a failed follow-up request leaves the process pinned to a
    // network the system has torn down.
    if (specifierNetwork != null) {
      specifierNetwork = null
      try {
        connectivity.bindProcessToNetwork(null)
      } catch (_: SecurityException) {
      }
    }
    joinRetryRunnable?.let { joinRetryHandler.removeCallbacks(it) }
    specifierCallback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }

    val specifierBuilder = WifiNetworkSpecifier.Builder().setSsid(ssid)
    if (!passphrase.isNullOrEmpty()) {
      specifierBuilder.setWpa2Passphrase(passphrase)
    }
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      // `atlas` is a local AP without internet; matching must not require the
      // INTERNET capability or the request never becomes available.
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifierBuilder.build())
      .build()

    // Binding IS deliberate: a plain OkHttp `fetch` otherwise goes out the
    // default network (the station's home LAN/router), which has no route into
    // the room node's softAP — so /api/node/time (the node's clock sync) always
    // fails on a device that also has another WiFi. Loopback (adb reverse ->
    // the fusion server) is unaffected by a process-to-network bind.
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        specifierAvailable = true
        specifierNetwork = network
        // The network is up: stop hammering the specifier.
        joinRetryRunnable?.let { joinRetryHandler.removeCallbacks(it) }
        try {
          connectivity.bindProcessToNetwork(network)
        } catch (_: SecurityException) {
          // Device in a restricted profile: stay on the default network.
        }
      }

      override fun onLost(network: Network) {
        specifierAvailable = false
        // Release the bind only if we are still on the network we lost, so a
        // newer requested room network keeps its binding.
        if (specifierNetwork == network) {
          specifierNetwork = null
          try {
            connectivity.bindProcessToNetwork(null)
          } catch (_: SecurityException) {
          }
        }
      }
    }
    specifierCallback = callback
    connectivity.requestNetwork(request, callback)

    val retry = object : Runnable {
      override fun run() {
        if (specifierAvailable || requestedSsid != ssid) return
        try {
          connectivity.requestNetwork(request, callback)
        } catch (_: IllegalArgumentException) {
          // Already registered: the pending request covers the next attempt.
        }
        joinRetryHandler.postDelayed(this, 15_000)
      }
    }
    joinRetryRunnable = retry
    joinRetryHandler.postDelayed(retry, 15_000)
    return true
  }

  private fun getObservation(): Map<String, Any?> {
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      ?: return mapOf(
        "connectedToSoshin" to false,
        "soshinVisible" to false,
        "soshinRssi" to null,
        "ssid" to null,
        "bssid" to null,
      )
    val info = wifi.connectionInfo
    val ssid = info?.ssid?.removeSurrounding("\"")
    val connected = specifierAvailable || (requestedSsid != null && ssid == requestedSsid)

    // If we are not associated with the transmitter, still measure its signal
    // from a WiFi scan. This lets the receiver stay on the internet/PC hotspot
    // (so reports reach the server) while still proving room proximity.
    var visible = connected
    var rssi = if (connected) info?.rssi else null
    if (!connected && requestedSsid != null) {
      val scanned = scanForSsid(wifi, requestedSsid!!)
      visible = scanned.first
      rssi = scanned.second
    }

    return mapOf(
      "connectedToSoshin" to connected,
      "soshinVisible" to visible,
      // Only report RSSI for the transmitter: either associated, or seen in a
      // scan with the exact requested SSID (never some other network's value).
      "soshinRssi" to rssi,
      "ssid" to ssid,
      "bssid" to (if (connected) info?.bssid else scannedBssid),
    )
  }

  /** Scan and return (visible, strongestRssi) for the requested SSID. */
  private fun scanForSsid(wifi: WifiManager, ssid: String): Pair<Boolean, Int?> {
    return try {
      wifi.startScan()
      val match = wifi.scanResults
        ?.filter { it.SSID?.removeSurrounding("\"") == ssid }
        ?.maxByOrNull { it.level }
      scannedBssid = match?.BSSID
      (match != null) to match?.level
    } catch (e: SecurityException) {
      (false) to null
    } catch (e: Exception) {
      (false) to null
    }
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
