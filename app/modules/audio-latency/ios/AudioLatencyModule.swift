import ExpoModulesCore
import AVFoundation

public class AudioLatencyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioLatency")

    Function("getOutputLatencyMs") {
      let session = AVAudioSession.sharedInstance()
      return session.outputLatency * 1000.0
    }
  }
}
