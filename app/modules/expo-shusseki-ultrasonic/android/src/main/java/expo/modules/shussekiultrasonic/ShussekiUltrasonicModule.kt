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
 * useful volume, so the stamp is FIXED, clearly-audible TONE BURSTS in the
 * ~1.8-2.6kHz band — in every phone's efficient passband, ALTERNATING between
 * two frequencies (A=4500 Hz, B=4450 Hz) every burst. Presence is decided by a
 * gain-invariant test: each tone frequency vs its own neighbour (off-freq)
 * reference, required to dominate for a fraction of the listen window.
 * Alternating defeats any stationary narrowband noise source: a jammer parked
 * on ONE frequency can satisfy only half of the pattern (2 of the 4 bursts),
 * and the detector demands BOTH tones — so a single-tone speaker hum or a
 * pitched app/plant can never forge presence. Repeating the burst cadence
 * on top of that defeats mic AGC and room echoes.
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

  // --- encode: alternating two-tone burst stamp ----------------------

  /** Stamp tones alternate every burst: A, B, A, B. */
  private val stampFreqA = 20000.0
  private val stampFreqB = 19600.0
  private val burstMs = 120L
  private val bursts = 4
  private val burstGapMs = 220L
  private val amplitude = 0.97

  private fun transmitStamp() {
    val burstFreqs = doubleArrayOf(stampFreqA, stampFreqB, stampFreqA, stampFreqB)
    val burstN = (sampleRate * burstMs / 1000.0).toInt()
    val gapN = (sampleRate * burstGapMs / 1000.0).toInt()
    val rampN = (sampleRate * 3 / 1000).toInt() // ~3ms soft edges
    val total = bursts * burstN + (bursts - 1) * gapN
    val pcm = ShortArray(total)
    var idx = 0
    for (b in 0 until bursts) {
      // burst: continuous-phase tone, soft 3ms ramp at burst edges
      val phaseInc = 2.0 * Math.PI * burstFreqs[b % burstFreqs.size] / sampleRate
      var phase = 0.0
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
  /** Per-tone off-frequency neighbours used as the noise reference. */
  private val refFreqA = 21000.0
  private val refFreqB = 18500.0
  /** Each tone must dominate its neighbour for at least this window fraction. */
  private val minOnFraction = 0.08
  /** A frame counts as "on tone" when the tone is this much above its neighbour. */
  private val onToneRatio = 2.0
  /**
   * ANTI-SILENCE GUARD ONLY — deliberately NOT a power gate.
   * Peak magnitude below this means the mic path is unreadable (digital
   * blank/flatline, muted mic, or a recording playing on top of quantisation
   * noise), where the tone-vs-neighbour RATIO could pass spuriously. It is
   * sized ~7x BELOW the weakest real stamp measured on the bench (6.6e5 at the
   * worst mic placement), so any real amp+speaker at a plausible hearing
   * distance passes comfortably; only a dead path fails it.
   */
  private val minPeakTone = 1e4

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

    // Per-frame tone vs neighbour-reference ratio for BOTH stamp frequencies.
    // Gain-invariant (AGC cancels in the ratio): no absolute power gate sits in
    // the decision — a real stamp at any distance and volume is judged on the
    // same terms as a loud one.
    val magA = DoubleArray(frames)
    val refMagA = DoubleArray(frames)
    val magB = DoubleArray(frames)
    val refMagB = DoubleArray(frames)
    var grandTotal = 0.0
    for (f in 0 until frames) {
      magA[f] = goertzel(buf, f * frame, frame, stampFreqA)
      refMagA[f] = goertzel(buf, f * frame, frame, refFreqA)
      magB[f] = goertzel(buf, f * frame, frame, stampFreqB)
      refMagB[f] = goertzel(buf, f * frame, frame, refFreqB)
      grandTotal += magA[f] + refMagA[f] + magB[f] + refMagB[f]
    }

    // Per-frequency on-fraction: how much of the window had each tone clearly
    // dominating its own neighbour band (>= 3x). A bursts cover ~29% of a
    // pattern cycle (2 of 4 bursts) and mic AGC + room echo make runs flicker,
    // so no exact run/burst count is required — dominance over a fraction of
    // the window is enough. Requiring BOTH tones halves any single-tone
    // spurious source's chance and kills every stationary narrowband jammer.
    val burstFrames = (burstMs / frameMs).toInt()
    var onFramesA = 0
    var onFramesB = 0
    var runs = 0
    var inRun = false
    var longestRun = 0
    var currentRun = 0
    var peakToneA = 0.0
    var peakToneB = 0.0
    for (f in 0 until frames) {
      val onA = refMagA[f] > 0 && magA[f] > onToneRatio * refMagA[f]
      val onB = refMagB[f] > 0 && magB[f] > onToneRatio * refMagB[f]
      if (onA) onFramesA++
      if (onB) onFramesB++
      if (onA || onB) {
        if (!inRun) { runs++; inRun = true; currentRun = 0 }
        currentRun++
        if (currentRun > longestRun) longestRun = currentRun
      } else {
        inRun = false
        currentRun = 0
      }
      if (magA[f] > peakToneA) peakToneA = magA[f]
      if (magB[f] > peakToneB) peakToneB = magB[f]
    }

    // Decision: BOTH tone frequencies must each dominate their neighbour band
    // for a meaningful part of the window, plus the tiny anti-silence floor.
    val fracA = if (frames > 0) onFramesA.toDouble() / frames else 0.0
    val fracB = if (frames > 0) onFramesB.toDouble() / frames else 0.0
    val score = (fracA + fracB) / 2.0
    val present = fracA >= minOnFraction && fracB >= minOnFraction &&
      peakToneA > minPeakTone && peakToneB > minPeakTone

    val miss = when {
      present -> "none"
      runs >= 1 -> "decode_failed"
      else -> "no_signal"
    }
    android.util.Log.i(
      "ShussekiUltrasonic",
      "TONE fracA=${String.format("%.2f", fracA)} peakA=${String.format("%.0f", peakToneA)} " +
        "fracB=${String.format("%.2f", fracB)} peakB=${String.format("%.0f", peakToneB)} " +
        "runs=$runs longest=$longestRun expected=${bursts * burstFrames} present=$present",
    )
    return mapOf(
      "received" to present,
      "valid" to (if (present) true else null),
      "code" to null,
      "snr" to score * 100.0,
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
