package expo.modules.shussekible

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
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Soshin advertises a room beacon; Jushin scans for node readings.
 * Requires BLUETOOTH_ADVERTISE / BLUETOOTH_SCAN and location permissions
 * (declared in app.json). Build + behavior must be verified on a device.
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

    AsyncFunction("advertise") { roomId: String, nodeId: String ->
      startAdvertising(roomId, nodeId)
    }

    AsyncFunction("stopAdvertise") {
      stopAdvertising()
    }

    AsyncFunction("scanOnce") { timeoutMs: Double ->
      scanOnce(timeoutMs.toLong())
    }
  }

  private fun startAdvertising(roomId: String, nodeId: String) {
    val adapter = bluetoothAdapter ?: throw IllegalStateException("Bluetooth unavailable")
    advertiser = adapter.bluetoothLeAdvertiser ?: throw IllegalStateException("LE advertiser unavailable")

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(false)
      .build()

    // Encode the node id (room + node) into manufacturer data.
    val payload = "$roomId|$nodeId".toByteArray(Charsets.UTF_8)
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addManufacturerData(0xABCD, payload)
      .build()

    advertiseCallback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {}
      override fun onStartFailure(errorCode: Int) {
        throw IllegalStateException("Advertise failed: $errorCode")
      }
    }
    advertiser?.startAdvertising(settings, data, advertiseCallback)
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
    return scanResults.map { r ->
      mapOf(
        "nodeId" to (r.device.address ?: "unknown"),
        "rssi" to r.rssi,
      )
    }
  }
}