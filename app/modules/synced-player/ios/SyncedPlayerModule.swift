import ExpoModulesCore
import AVFoundation

public class SyncedPlayerModule: Module {
  private var engine: AVAudioEngine?
  private var playerNode: AVAudioPlayerNode?
  private var varispeed: AVAudioUnitVarispeed?
  private var audioBuffer: AVAudioPCMBuffer?
  // Frame offset within the buffer where the last play() call started.
  // Used to calculate absolute loop position from playerTime.sampleTime.
  private var playStartOffsetFrames: Int64 = 0
  private var statusTimer: Timer?

  public func definition() -> ModuleDefinition {
    Name("SyncedPlayer")
    Events("onPlaybackStatus")

    // Load the audio file at the given local file:// URI into an in-memory
    // PCM buffer and wire up AVAudioEngine. Must be called before playAsync.
    AsyncFunction("loadAsync") { (uri: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          // Activate audio session for background / silent-mode playback.
          let session = AVAudioSession.sharedInstance()
          try session.setCategory(.playback, mode: .default, options: [])
          try session.setActive(true)

          guard let url = URL(string: uri) else {
            promise.reject("INVALID_URI", "Cannot parse URI: \(uri)")
            return
          }
          let file = try AVAudioFile(forReading: url)
          let format = file.processingFormat
          let frameCount = AVAudioFrameCount(file.length)
          guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            promise.reject("BUFFER_ERROR", "Could not allocate PCM buffer")
            return
          }
          try file.read(into: buffer)
          buffer.frameLength = frameCount

          // playerNode -> varispeed -> mainMixerNode
          // Changing varispeed.rate is a real-time DSP op — no buffer flush.
          let engine = AVAudioEngine()
          let playerNode = AVAudioPlayerNode()
          let varispeed = AVAudioUnitVarispeed()
          engine.attach(playerNode)
          engine.attach(varispeed)
          engine.connect(playerNode, to: varispeed, format: format)
          engine.connect(varispeed, to: engine.mainMixerNode, format: format)
          try engine.start()

          self.engine = engine
          self.playerNode = playerNode
          self.varispeed = varispeed
          self.audioBuffer = buffer
          self.playStartOffsetFrames = 0

          promise.resolve()
        } catch {
          promise.reject("LOAD_ERROR", error.localizedDescription)
        }
      }
    }

    // Seek to offsetMs within the loop and begin playing.
    // Schedules a "tail" segment from offsetMs to end-of-file, then queues
    // the full buffer looping seamlessly after that. Also starts the 500ms
    // status event timer.
    AsyncFunction("playAsync") { (offsetMs: Double, promise: Promise) in
      guard let buffer = self.audioBuffer, let player = self.playerNode else {
        promise.reject("NOT_LOADED", "Call loadAsync first")
        return
      }

      let sampleRate = buffer.format.sampleRate
      let totalFrames = Int64(buffer.frameLength)
      var offsetFrames = Int64(offsetMs / 1000.0 * sampleRate)
      offsetFrames = max(0, min(offsetFrames, totalFrames - 1))

      player.stop()
      self.playStartOffsetFrames = offsetFrames

      if offsetFrames > 0 {
        let tailCount = AVAudioFrameCount(totalFrames - offsetFrames)
        if let tail = self.sliceBuffer(buffer,
                                       startFrame: AVAudioFramePosition(offsetFrames),
                                       frameCount: tailCount) {
          player.scheduleBuffer(tail, at: nil, options: []) { [weak self] in
            // After the tail finishes, loop the full buffer indefinitely.
            guard let self, let buf = self.audioBuffer, let p = self.playerNode else { return }
            p.scheduleBuffer(buf, at: nil, options: .loops, completionHandler: nil)
          }
        }
      } else {
        player.scheduleBuffer(buffer, at: nil, options: .loops, completionHandler: nil)
      }

      player.play()
      self.startStatusTimer()
      promise.resolve()
    }

    // Change playback rate in real time. AVAudioUnitVarispeed applies the
    // change as a DSP parameter — no seek, no buffer flush, no audible gap.
    // Valid range: 0.25 – 4.0.
    Function("setRate") { (rate: Float) in
      self.varispeed?.rate = rate
    }

    AsyncFunction("stopAsync") { (promise: Promise) in
      self.playerNode?.stop()
      self.stopStatusTimer()
      promise.resolve()
    }

    AsyncFunction("unloadAsync") { (promise: Promise) in
      self.tearDown()
      promise.resolve()
    }
  }

  // MARK: - Helpers

  /// Returns a new PCM buffer containing frames [startFrame, startFrame+frameCount).
  private func sliceBuffer(_ buffer: AVAudioPCMBuffer,
                            startFrame: AVAudioFramePosition,
                            frameCount: AVAudioFrameCount) -> AVAudioPCMBuffer? {
    let format = buffer.format
    guard let sliced = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
          let src = buffer.floatChannelData,
          let dst = sliced.floatChannelData else { return nil }
    sliced.frameLength = frameCount
    let channelCount = Int(format.channelCount)
    let start = Int(startFrame)
    let count = Int(frameCount)
    for ch in 0..<channelCount {
      memcpy(dst[ch], src[ch] + start, count * MemoryLayout<Float>.stride)
    }
    return sliced
  }

  /// Calculates the current playback position within the loop in milliseconds.
  /// Returns -1 when position cannot be determined (not yet playing, etc.).
  ///
  /// AVAudioPlayerNode.playerTime(forNodeTime:).sampleTime reflects buffer
  /// samples consumed, which advances at `varispeed.rate * hardwareSampleRate`
  /// per second — i.e., it tracks the actual buffer position correctly even
  /// during rate changes.
  private func getCurrentPositionMs() -> Double {
    guard let player = playerNode,
          player.isPlaying,
          let lastRenderTime = player.lastRenderTime,
          lastRenderTime.isSampleTimeValid,
          let playerTime = player.playerTime(forNodeTime: lastRenderTime),
          let buffer = audioBuffer else { return -1 }

    let totalFrames = Int64(buffer.frameLength)
    var frame = (playerTime.sampleTime + playStartOffsetFrames) % totalFrames
    if frame < 0 { frame += totalFrames }
    return Double(frame) / buffer.format.sampleRate * 1000.0
  }

  private func startStatusTimer() {
    DispatchQueue.main.async {
      self.statusTimer?.invalidate()
      self.statusTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
        guard let self else { return }
        let posMs = self.getCurrentPositionMs()
        let isPlaying = self.playerNode?.isPlaying ?? false
        self.sendEvent("onPlaybackStatus", [
          "positionMs": posMs,
          "isPlaying": isPlaying,
        ])
      }
    }
  }

  private func stopStatusTimer() {
    DispatchQueue.main.async {
      self.statusTimer?.invalidate()
      self.statusTimer = nil
    }
  }

  private func tearDown() {
    stopStatusTimer()
    playerNode?.stop()
    engine?.stop()
    playerNode = nil
    varispeed = nil
    engine = nil
    audioBuffer = nil
    playStartOffsetFrames = 0
  }
}
