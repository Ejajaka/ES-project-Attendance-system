package expo.modules.shussekiultrasonic

import android.Manifest
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.modules.Module
import kotlin.concurrent.thread
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Ultrasonic PRESENCE stamp, not a data link.
 *
 * Design (architecture "detection-only"): Soshin emits a repeating 8-14kHz
 * linear chirp; Jushin runs a matched-filter presence test — is the chirp's
 * time-frequency trajectory present? This is far more robust than per-symbol
 * FSK decoding over a phone speaker-mic (band-limited, distorted, echo-y,
 * with nondeterministic record start latency). We do not try to carry a code
 * over the audible path; identity + rolling code ride the (reliable) BLE
 * channel instead.
 *
 * 8-14kHz is deliberately in-band: every phone we tested rolls off hard at
 * 15-18.5kHz, but passes 8-14kHz cleanly. Reliability wins over inaudibility
 * for a research prototype.
 */
class ShussekiUltrasonicModule : Module() {
  private val sampleRate = 44100

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("ShussekiUltrasonic")

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.RECORD_AUDIO,
      )
    }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.RECORD_AUDIO,
      )
    }

    /** Soshin: emit the repeating chirp presence stamp (payload ignored). */
    AsyncFunction("transmit") { _code: String ->
      transmitStamp()
    }
    /** Jushin: record and decide whether the chirp stamp is present. */
    AsyncFunction("listen") { timeoutMs: Double ->
      detectPresence(timeoutMs.toLong())
    }
    /** Same-device self-test: transmit + record concurrently. */
    AsyncFunction("loopback") { timeoutMs: Double ->
      loopback(timeoutMs.toLong())
    }
    AsyncFunction("startListener") { /* foreground-service hook */ }
    AsyncFunction("stopListener") { /* foreground-service hook */ }
  }

  /** Concurrent transmit+record on one device (speaker→mic path) for smoke tests. */
  private fun loopback(timeoutMs: Long): Map<String, Any?> {
    val tx = thread { transmitStamp() }
    Thread.sleep(30)
    val result = detectPresence(timeoutMs)
    tx.join()
    return result
  }

  // --- encode: chirp stamp ------------------------------------------------

  private val chirpStart = 8000.0
  private val chirpEnd = 14000.0
  private val chirpMs = 80L
  private val stampRepeats = 4
  private val gapMs = 240L
  private val amplitude = 0.97

  /** Generate one 8->14kHz linear chirp of `durMs`. Continuous phase. */
  private fun chirp(durMs: Long): ShortArray {
    val n = (sampleRate * durMs / 1000.0).toInt()
    val buf = ShortArray(n)
    val durS = durMs / 1000.0
    val slope0 = 2.0 * Math.PI * chirpStart
    val slope1 = 2.0 * Math.PI * (chirpEnd - chirpStart) / (2.0 * durS)
    for (i in 0 until n) {
      val t = i.toDouble() / sampleRate
      val phase = slope0 * t + slope1 * t * t
      val env = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / n)
      buf[i] = (Math.sin(phase) * amplitude * env * Short.MAX_VALUE).toInt().toShort()
    }
    return buf
  }

  private fun transmitStamp() {
    val chip = chirp(chirpMs)
    val silence = ShortArray((sampleRate * gapMs / 1000).toInt())
    val parts = mutableListOf<ShortArray>()
    for (i in 0 until stampRepeats) {
      parts.add(chip)
      if (i < stampRepeats - 1) parts.add(silence)
    }
    val total = parts.sumOf { it.size }
    val pcm = ShortArray(total)
    var off = 0
    for (p in parts) { p.copyInto(pcm, off); off += p.size }

    val track = AudioTrack.Builder()
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build(),
      )
      .setBufferSizeInBytes(pcm.size * 2)
      .build()
    track.play()
    track.write(pcm, 0, pcm.size)
    track.stop()
    track.release()
  }

  // --- matched-filter detection ------------------------------------------

  private val frameMs = 20L // spectrogram time resolution
  private val bins = Array(16) { 7000.0 + it * 500.0 } // 7000..14500 Hz

  private fun detectPresence(timeoutMs: Long): Map<String, Any?> {
    val minBuf = AudioRecord.getMinBufferSize(
      sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
    )
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, sampleRate),
      )
    } catch (e: Exception) {
      return mapOf("received" to false, "valid" to null, "code" to null, "snr" to null, "missReason" to "service_killed")
    }
    val n = (sampleRate * timeoutMs / 1000.0).toInt()
    val buf = ShortArray(n)
    try {
      record.startRecording()
      var totalRead = 0
      while (totalRead < n) {
        val r = record.read(buf, totalRead, n - totalRead)
        if (r <= 0) break
        totalRead += r
      }
      android.util.Log.i(
        "ShussekiUltrasonic",
        "CAPTURE state=${record.recordingState} read=$totalRead n=$n minBuf=$minBuf",
      )
    } finally {
      try { record.stop() } catch (_: IllegalStateException) {}
      record.release()
    }

    val frame = (sampleRate * frameMs / 1000).toInt()
    val frames = n / frame
    if (frames < 4) {
      return mapOf("received" to false, "valid" to null, "code" to null, "snr" to null, "missReason" to "no_signal")
    }

    // Coarse spectrogram: goertzel magnitude per (frame, bin).
    val spec = Array(frames) { DoubleArray(bins.size) }
    for (f in 0 until frames) {
      for (b in bins.indices) {
        spec[f][b] = goertzel(buf, f * frame, frame, bins[b])
      }
    }

    // Differential discriminator: an up-chirp concentrates energy on the chirp
    // trajectory but essentially NONE on the mirror/down-chirp trajectory. A
    // room's tonal noise (fans, hum) doesn't prefer either, so (chirp - mirror)/total
    // separates a real chirp from ambient far better than raw ratio alone.
    val chirpFrames = (chirpMs / frameMs).toInt()
    val binAt = IntArray(chirpFrames)
    for (i in 0 until chirpFrames) {
      val t = i.toDouble() / chirpFrames
      val f = chirpStart + (chirpEnd - chirpStart) * t
      binAt[i] = nearestBin(f)
    }

    var bestScore = -1.0
    var bestChirp = 0.0
    var bestRatio = 0.0
    var bestOff = 0
    for (off in 0..(frames - chirpFrames)) {
      var chirpSum = 0.0
      var counterSum = 0.0
      var total = 0.0
      for (i in 0 until chirpFrames) {
        val row = spec[off + i]
        chirpSum += row[binAt[i]]
        counterSum += row[binAt[chirpFrames - 1 - i]]
        for (b in bins.indices) total += row[b]
      }
      if (total > 0.0) {
        val score = (chirpSum - counterSum) / total
        val ratio = chirpSum / total
        if (score > bestScore) { bestScore = score; bestChirp = chirpSum; bestRatio = ratio; bestOff = off }
      }
    }

    // Diagnostic: total energy in the whole observed band + strongest cell, so we
    // can distinguish "chirp not arriving" from "trajectory match needs tuning".
    var grandTotal = 0.0
    var cellMax = 0.0
    for (f in 0 until frames) for (b in bins.indices) {
      grandTotal += spec[f][b]
      if (spec[f][b] > cellMax) cellMax = spec[f][b]
    }
    android.util.Log.i(
      "ShussekiUltrasonic",
      "PRES grandTotal=${String.format("%.0f", grandTotal)} cellMax=${String.format("%.0f", cellMax)} " +
        "bestScore=${String.format("%.3f", bestScore)} bestChirp=${String.format("%.0f", bestChirp)} " +
        "ratio=${String.format("%.3f", bestRatio)} off=$bestOff",
    )

    val diffThreshold = 0.15
    val chirpFloor = 2e9 // provisional; should be fit from ambient+present data collection
    val present = bestScore >= diffThreshold && bestChirp > chirpFloor
    val miss = when {
      present -> "none"
      bestScore >= diffThreshold * 0.5 -> "decode_failed"
      else -> "no_signal"
    }
    return mapOf(
      "received" to present,
      "valid" to (if (present) true else null),
      "code" to null,
      "snr" to (bestScore * 1000.0),
      "missReason" to miss,
      "ratio" to bestScore,
      "energy" to grandTotal,
    )
  }

  private fun nearestBin(freq: Double): Int {
    var best = 0
    var bestD = Double.MAX_VALUE
    for (i in bins.indices) {
      val d = Math.abs(bins[i] - freq)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  /** Goertzel magnitude at `freq` over buf[start, start+len). */
  private fun goertzel(buf: ShortArray, start: Int, len: Int, freq: Double): Double {
    val k = freq / sampleRate * len
    val w = 2.0 * Math.PI * k / len
    val cosine = Math.cos(w)
    val coeff = 2.0 * cosine
    var sPrev = 0.0
    var sPrev2 = 0.0
    for (i in start until start + len) {
      val x = buf[i].toDouble()
      val s = x + coeff * sPrev - sPrev2
      sPrev2 = sPrev
      sPrev = s
    }
    return sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2
  }
}