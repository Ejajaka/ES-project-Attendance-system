import ExpoModulesCore
import AVFoundation

/**
 * Ultrasonic rolling-code tone (FSK, one near-ultrasonic frequency per digit).
 * Soshin transmits; Jushin listens and decodes. Centre frequencies / thresholds
 * are research-tunable and MUST be validated on real hardware (speaker + mic
 * frequency response varies by device).
 */
class ShussekiUltrasonicModule: Module {
  private let sampleRate: Double = 44100
  private let symbolSec: Double = 0.08
  private let baseFreq: Double = 18500
  private let freqStep: Double = 200
  private let preambleFreq: Double = 18000

  func definition() -> ModuleDefinition {
    Name("ShussekiUltrasonic")

    AsyncFunction("transmit") { (code: String) in
      try self.transmit(code: code)
    }
    AsyncFunction("listen") { (timeoutMs: Double) -> [String: Any?] in
      try self.listen(timeoutMs: timeoutMs)
    }
    AsyncFunction("startListener") {}
    AsyncFunction("stopListener") {}
  }

  private func tone(freq: Double, samples: Int) -> [Float] {
    var buf = [Float](repeating: 0, count: samples)
    let inc = 2 * Double.pi * freq / sampleRate
    for i in 0..<samples {
      let env = 0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(samples))
      buf[i] = Float(sin(inc * Double(i)) * 0.8 * env)
    }
    return buf
  }

  private func transmit(code: String) throws {
    let engine = AVAudioEngine()
    let samplesPerSymbol = Int(sampleRate * symbolSec)
    var pcm = tone(freq: preambleFreq, samples: Int(sampleRate * 0.2))
    for c in code {
      guard let d = c.wholeNumberValue else { continue }
      pcm.append(contentsOf: tone(freq: baseFreq + Double(d) * freqStep, samples: samplesPerSymbol))
    }
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count))!
    for i in 0..<pcm.count { buffer.floatChannelData?.pointee[i] = pcm[i] }
    buffer.frameLength = AVAudioFrameCount(pcm.count)
    try engine.start()
    player.play()
    player.scheduleBuffer(buffer) { engine.stop() }
    usleep(useconds_t(Double(pcm.count) / sampleRate * 1_000_000) + 200_000)
  }

  private func listen(timeoutMs: Double) throws -> [String: Any?] {
    let engine = AVAudioEngine()
    let format = engine.inputNode.outputFormat(forBus: 0)
    let need = Int(Double(format.sampleRate) * timeoutMs / 1000.0)
    var captured = [Float](repeating: 0, count: need)
    var filled = 0
    let semaphore = DispatchSemaphore(value: 0)
    engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
      let n = min(buffer.frameLength, AVAudioFrameCount(need - filled))
      if n > 0 {
        let ptr = buffer.floatChannelData?[0]
        for i in 0..<Int(n) { captured[filled + i] = ptr?[i] ?? 0 }
        filled += Int(n)
      }
      if filled >= need { semaphore.signal() }
    }
    try engine.start()
    _ = semaphore.wait(timeout: .now() + timeoutMs / 1000.0 + 0.2)
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)

    let sr = Double(format.sampleRate)
    let symbolSamples = Int(sr * symbolSec)
    let startIdx = Int(sr * 0.2)
    var code = ""
    var snrMax = 0.0
    var detected = false
    var i = startIdx
    while i + symbolSamples <= filled {
      var bestFreq = 0.0
      var bestMag = -1.0
      for d in 0...9 {
        let f = baseFreq + Double(d) * freqStep
        let mag = goertzel(captured, i, symbolSamples, f, sr)
        if mag > bestMag { bestMag = mag; bestFreq = f }
      }
      let noise = goertzel(captured, i, symbolSamples, 1000, sr)
      if bestMag > 1e3 {
        detected = true
        let d = Int(((bestFreq - baseFreq) / freqStep).rounded())
        code.append(String(d))
        snrMax = max(snrMax, bestMag / (noise + 1))
      }
      i += symbolSamples
    }

    if !detected {
      return ["received": false, "valid": nil, "code": nil, "snr": nil, "missReason": "no_signal"]
    }
    let valid = code.count == 6 && code.allSatisfy { $0.isNumber }
    return [
      "received": true,
      "valid": valid,
      "code": code,
      "snr": snrMax,
      "missReason": valid ? "none" : "decode_failed",
    ]
  }

  private func goertzel(_ buf: [Float], _ start: Int, _ len: Int, _ freq: Double, _ sr: Double) -> Double {
    let k = freq / sr * Double(len)
    let w = 2 * Double.pi * k / Double(len)
    let coeff = 2 * cos(w)
    var sPrev = 0.0
    var sPrev2 = 0.0
    for i in start..<start + len {
      let x = buf[i]
      let s = x + coeff * sPrev - sPrev2
      sPrev2 = sPrev
      sPrev = s
    }
    return sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2
  }
}
