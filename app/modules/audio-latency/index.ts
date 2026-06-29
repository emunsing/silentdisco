import { requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

const AudioLatency =
  Platform.OS === "ios" ? requireNativeModule("AudioLatency") : null;

export function getOutputLatencyMs(): number {
  if (!AudioLatency) return 0;
  return AudioLatency.getOutputLatencyMs();
}
