package expo.modules.shussekiultrasonic

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import expo.modules.kotlin.modules.Module
import kotlin.math.roundToInt
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Ultrasonic rolling-code tone. Soshin transmits (FSK: one near-ultrasonic
 * frequency per digit); Jushin listens and decodes. Thresholds/centre
 * frequencies are research-tunable and MUST be validated on real hardware.
 *
 * NOTE: continuous background listening needs a foreground service with a
 * persistent notification (declared in app.json). This scaffold runs inline.
 */
class ShussekiUltrasonicModule : Module() {
  private val sampleRate = 44100
  private val symbolMs = 80
  private val baseFreq = 18500.0
  private val freqStep = 200.0
  private val preambleFreq = 18000.0

  override fun definition() = ModuleDefinition {
    Name("ShussekiUltrasonic")

    AsyncFunction("transmit") { code: String ->
      transmit(code)
    }
    AsyncFunction("listen") { timeoutMs: Double ->
      listen(timeoutMs.toLong())
    }
    AsyncFunction("startListener") { /* foreground-service hook; see note */ }
    AsyncFunction("stopListener") { /* foreground-service hook; see note */ }
  }

  private fun digitToFreq(d: Char): Double = baseFreq + (d.digitToInt() * freqStep)
  private fun freqToDigit(f: Double): Int = ((f - baseFreq) / freqStep).roundToInt().coerceIn(0, 9)

  private fun tone(freq: Double, durationMs: Long): ShortArray {
    val n = (sampleRate * durationMs / 1000.0).toInt()
    val buf = ShortArray(n)
    val phaseInc = 2.0 * Math.PI * freq / sampleRate
    for (i in 0 until n) {
      // raised-cosine envelope to avoid clicks
      val env = 0.5 - 0.5 * Math.cos(2.0 * Math.PI * i / n)
      buf[i] = (Math.sin(phaseInc * i) * 0.8 * env * Short.MAX_VALUE).toInt().toShort()
    }
    return buf
  }

  private fun transmit(code: String) {
    val parts = mutableListOf<ShortArray>()
    parts.add(tone(preambleFreq, 200))
    for (c in code) parts.add(tone(digitToFreq(c), symbolMs.toLong()))
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

  private fun listen(timeoutMs: Long): Map<String, Any?> {
    val minBuf = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val record = AudioRecord(
      MediaRecorder.AudioSource.MIC,
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      maxOf(minBuf, sampleRate),
    )
    val n = (sampleRate * timeoutMs / 1000.0).toInt()
    val buf = ShortArray(n)
    record.startRecording()
    record.read(buf, 0, n)
    record.stop()
    record.release()

    // Skip the preamble region, then decode one digit per symbol window.
    val symbolSamples = (sampleRate * symbolMs / 1000)
    val startIdx = (sampleRate * 200 / 1000) // after preamble
    val sb = StringBuilder()
    var snrMax = 0.0
    var detected = false
    var i = startIdx
    while (i + symbolSamples <= n) {
      var bestFreq = 0.0
      var bestMag = -1.0
      var noise = 0.0
      for (d in 0..9) {
        val f = digitToFreq(d.digitToChar())
        val mag = goertzel(buf, i, symbolSamples, f)
        if (mag > bestMag) { bestMag = mag; bestFreq = f }
      }
      // noise = energy away from the candidate band
      noise = goertzel(buf, i, symbolSamples, 1000.0)
      if (bestMag > 1e6) {
        detected = true
        sb.append(freqToDigit(bestFreq).digitToChar())
        snrMax = maxOf(snrMax, bestMag / (noise + 1.0))
      }
      i += symbolSamples
    }

    return if (!detected) {
      mapOf("received" to false, "valid" to null, "code" to null, "snr" to null, "missReason" to "no_signal")
    } else {
      val code = sb.toString()
      mapOf(
        "received" to true,
        "valid" to code.matches(Regex("\\d{6}")),
        "code" to code,
        "snr" to snrMax,
        "missReason" to if (code.matches(Regex("\\d{6}"))) "none" else "decode_failed",
      )
    }
  }

  /** Goertzel magnitude at `freq` over buf[start, start+len). */
  private fun goertzel(buf: ShortArray, start: Int, len: Int, freq: Double): Double {
    val k = (freq / sampleRate * len)
    val w = 2.0 * Math.PI * k / len
    val cosine = Math.cos(w)
    var coeff = 2.0 * cosine
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
