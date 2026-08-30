package expo.modules.shussekible

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Soshin advertises a room beacon; Jushin scans for node readings.
 * Requires BLUETOOTH_ADVERTISE / BLUETOOTH_SCAN / BLUETOOTH_CONNECT runtime
 * permissions (API 31+); requestPermissionsAsync prompts for them.
 */
class ShussekiBleModule : Module() {
  private val context: Context
    get() = appContext.reactContext
      ?: throw IllegalStateException("React context unavailable")

  private val bluetoothAdapter: BluetoothAdapter?
    get() = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private var advertiser: BluetoothLeAdvertiser? = null
  private var scanner: BluetoothLeScanner? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var scanCallback: ScanCallback? = null
  private val scanResults = mutableListOf<ScanResult>()

  override fun definition() = ModuleDefinition {
    Name("ShussekiBle")

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      // BLUETOOTH_SCAN/ADVERTISE/CONNECT are runtime permissions only on
      // API 31+; on older devices BLE needs only location + the legacy
      // BLUETOOTH/BLUETOOTH_ADMIN normal permissions (declared in manifest).
      val requested = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(
          Manifest.permission.BLUETOOTH_SCAN,
          Manifest.permission.BLUETOOTH_ADVERTISE,
          Manifest.permission.BLUETOOTH_CONNECT,
          Manifest.permission.ACCESS_FINE_LOCATION,
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
      val requested = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        arrayOf(
          Manifest.permission.BLUETOOTH_SCAN,
          Manifest.permission.BLUETOOTH_ADVERTISE,
          Manifest.permission.BLUETOOTH_CONNECT,
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

    AsyncFunction("advertise") { roomId: String, nodeId: String, code: String? ->
      startAdvertising(roomId, nodeId, code)
    }

    AsyncFunction("stopAdvertise") {
      stopAdvertising()
    }

    AsyncFunction("scanOnce") { timeoutMs: Double ->
      scanOnce(timeoutMs.toLong())
    }

    AsyncFunction("getState") {
      mapOf(
        "enabled" to (bluetoothAdapter?.isEnabled ?: false),
        "adapterAvailable" to (bluetoothAdapter != null),
      )
    }

    /** Best-effort power-on: turns BT on, or prompts the user if consent is needed. */
    AsyncFunction("ensureEnabled") {
      ensureEnabled()
    }
  }

  private fun ensureEnabled(): Boolean {
    val adapter = bluetoothAdapter ?: return false
    if (adapter.isEnabled) return true
    val ok = try {
      adapter.enable()
    } catch (e: Exception) {
      false
    }
    if (!ok) {
      // Ask the user via the system Bluetooth enable dialog.
      try {
        val ctx = appContext.currentActivity
        if (ctx != null) {
          val i = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
          if (i.resolveActivity(ctx.packageManager) != null) ctx.startActivity(i)
        }
      } catch (_: Exception) {}
    }
    return adapter.isEnabled
  }

  /**
   * Start (or refresh) the room beacon. Waits for the AdvertiseCallback to
   * settle (success or failure) so the result — not an uncaught exception from
   * the binder thread — is what the JS side sees. Without this, a transient
   * advertise failure (e.g. "already started") crashes the whole app.
   */
  private fun startAdvertising(roomId: String, nodeId: String, code: String?): Map<String, Any?> {
    val adapter = bluetoothAdapter ?: throw IllegalStateException("Bluetooth unavailable")
    advertiser = adapter.bluetoothLeAdvertiser ?: throw IllegalStateException("LE advertiser unavailable")

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(false)
      .build()

    // Encode node + optional rolling code into manufacturer data. Deliberately
    // compact: legacy advertising PDUs hold 31 bytes total (~4 of which are
    // the manufacturer header), and "room|node|code" overflows that limit for
    // realistic node ids + a 6-digit code — a failure that used to crash the
    // app. The room is already known to Jushin from session settings.
    val payload = "$nodeId" + (if (!code.isNullOrEmpty()) "|$code" else "")
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addManufacturerData(0xABCD, payload.toByteArray(Charsets.UTF_8))
      .build()

    val latch = CountDownLatch(1)
    val failure = intArrayOf(-1) // -1 = pending; errorCode >= 0 = failed
    val previous = advertiseCallback
    advertiseCallback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
        failure[0] = -1
        latch.countDown()
      }
      override fun onStartFailure(errorCode: Int) {
        failure[0] = errorCode
        latch.countDown()
      }
    }
    try {
      // Refresh semantics: stop any previous session first so re-advertising
      // a new rolling code doesn't bounce off ADVERTISE_FAILED_ALREADY_STARTED.
      if (previous != null) advertiser?.stopAdvertising(previous)
      advertiser?.startAdvertising(settings, data, advertiseCallback)
    } catch (e: Exception) {
      // Some OEMs throw from startAdvertising itself when the radio is busy.
      failure[0] = -100
      latch.countDown()
    }
    latch.await(3, TimeUnit.SECONDS)
    val errorCode = failure[0]
    return mapOf<String, Any?>(
      "started" to (errorCode < 0),
      "errorCode" to (if (errorCode >= 0) errorCode else null),
    )
  }

  private fun stopAdvertising() {
    advertiseCallback?.let { advertiser?.stopAdvertising(it) }
    advertiseCallback = null
  }

  private fun scanOnce(timeoutMs: Long): List<Map<String, Any>> {
    val adapter = bluetoothAdapter ?: throw IllegalStateException("Bluetooth unavailable")
    scanner = adapter.bluetoothLeScanner ?: throw IllegalStateException("LE scanner unavailable")

    scanResults.clear()
    val latch = CountDownLatch(1)
    scanCallback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        scanResults.add(result)
      }
    }
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .build()
    scanner?.startScan(null, settings, scanCallback)

    Handler(Looper.getMainLooper()).postDelayed({
      scanner?.stopScan(scanCallback)
      scanCallback = null
      latch.countDown()
    }, timeoutMs)

    latch.await(timeoutMs + 500, TimeUnit.MILLISECONDS)
    return toReadings()
  }

  private fun toReadings(): List<Map<String, Any>> {
    return scanResults.mapNotNull { r ->
      val rec = r.scanRecord ?: return@mapNotNull null
      // Shusseki Soshins advertise manufacturer id 0xABCD with payload
      // "nodeId|code" — lets Jushin identify its peer and receive the code.
      val mfg = rec.getManufacturerSpecificData(0xABCD) ?: return@mapNotNull null
      val payload = String(mfg, Charsets.UTF_8)
      val parts = payload.split('|')
      val nodeId = parts.getOrNull(0)?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
      val code = parts.getOrNull(1)?.takeIf { it.isNotBlank() }
      mapOf(
        "nodeId" to nodeId,
        "rssi" to r.rssi,
        "code" to (code ?: ""),
      )
    }
  }
}