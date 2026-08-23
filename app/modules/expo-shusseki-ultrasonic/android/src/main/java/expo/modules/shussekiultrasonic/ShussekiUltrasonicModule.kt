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
 * Ultrasonic PRESENCE stamp — but engineered for the hardware we actually have.
 *
 * Chassis (8-14kHz chirp) proved too weak on real phone speakers/mics at
 * useful volume, so the stamp is a FIXED, clearly-audible TONE BURST around
 * 1.8kHz — in every phone's efficient passband. Presence is decided by a
 * gain-invariant test: energy at the tone frequency vs a neighbour (off-freq)
 * reference, summed and required to repeat the on-off burst cadence. Repeating
 * the burst defeats mic AGC and room echoes far better than any single-tone.
 *
 * This is a DETECTION-ONLY link: no code is carried; identity + rolling code
 * travel over BLE (reliable). Room-boundedness is the research property being
 * measured.
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

    /** Soshin: emit the repeating tone-burst presence stamp (payload ignored). */
    AsyncFunction("transmit") { _code: String ->
      transmitStamp()
    }
    /** Jushin: record and decide whether the tone-burst stamp is present. */
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
    Thread.sleep(40)
    val result = detectPresence(timeoutMs)
    tx.join()
    return result
  }

  // --- encode: fixed-tone burst stamp --------------------------------

  private val stampFreq = 1800.0
  private val refFreq = 2300.0 // off-frequency neighbour used as the noise reference
  private val burstMs = 120L
  private val bursts = 4
  private val burstGapMs = 220L
  private val amplitude = 0.97

  private fun transmitStamp() {
    val burstN = (sampleRate * burstMs / 1000.0).toInt()
    val gapN = (sampleRate * burstGapMs / 1000.0).toInt()
    val rampN = (sampleRate * 3 / 1000).toInt() // ~3ms soft edges
    val total = bursts * burstN + (bursts - 1) * gapN
    val pcm = ShortArray(total)
    var idx = 0
    var phase = 0.0
    val phaseInc = 2.0 * Math.PI * stampFreq / sampleRate
    for (b in 0 until bursts) {
      // burst: continuous-phase tone, soft 3ms ramp at burst edges
      for (j in 0 until burstN) {
        val edge = minOf(j, burstN - 1 - j, rampN - 1)
        val env = if (edge > 0) edge.toDouble() / rampN else 0.0
        pcm[idx++] = (Math.sin(phase) * amplitude * env * Short.MAX_VALUE).toInt().toShort()
        phase += phaseInc
      }
      // gap: silence
      for (g in 0 until gapN) {
        if (idx < total) pcm[idx++] = 0
      }
    }

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

  // --- matched detection ---------------------------------------------

  private val frameMs = 20L

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
    } finally {
      try { record.stop() } catch (_: IllegalStateException) {}
      record.release()
    }

    val frame = (sampleRate * frameMs / 1000).toInt()
    val frames = n / frame

    // Per-frame tone vs neighbour-reference ratio; a real burst makes the tone
    // freq dominate its neighbour. Gain-invariant (AGC cancels in the ratio).
    val toneMag = DoubleArray(frames)
    val refMag = DoubleArray(frames)
    var grandTotal = 0.0
    for (f in 0 until frames) {
      toneMag[f] = goertzel(buf, f * frame, frame, stampFreq)
      refMag[f] = goertzel(buf, f * frame, frame, refFreq)
      grandTotal += toneMag[f] + refMag[f]
    }

    // Count frames that are clearly "on tone" and the number of on-RUNS (bursts).
    val burstFrames = (burstMs / frameMs).toInt()
    val onToneRatio = 3.0
    var onFrames = 0
    var runs = 0
    var inRun = false
    var peakTone = 0.0
    for (f in 0 until frames) {
      val on = refMag[f] > 0 && toneMag[f] > onToneRatio * refMag[f]
      if (on) {
        onFrames++
        if (!inRun) { runs++; inRun = true }
      } else {
        inRun = false
      }
      if (toneMag[f] > peakTone) peakTone = toneMag[f]
    }

    // Cadence: a stamp is `bursts` on-bursts separated by gaps. Require roughly
    // that many distinct on-runs and a plausible on-frame total.
    val runsOk = runs >= bursts - 1 && runs <= bursts + 2
    val totalOk = onFrames in (bursts * burstFrames - burstFrames)..(bursts * burstFrames + burstFrames)
    val present = runsOk && totalOk && peakTone > 1e7
    val score = if (runsOk) onFrames.toDouble() / (bursts * burstFrames) else 0.0

    val miss = when {
      present -> "none"
      runs >= 1 -> "decode_failed"
      else -> "no_signal"
    }
    android.util.Log.i(
      "ShussekiUltrasonic",
      "TONE onFrames=$onFrames runs=$runs expected=${bursts * burstFrames} peakTone=${String.format("%.0f", peakTone)} present=$present",
    )
    return mapOf(
      "received" to present,
      "valid" to (if (present) true else null),
      "code" to null,
      "snr" to (if (present) score * 100.0 else score * 100.0),
      "missReason" to miss,
      "ratio" to score,
      "energy" to grandTotal,
    )
  }

  /** Goertzel magnitude (squared) at `freq` over buf[start, start+len). */
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