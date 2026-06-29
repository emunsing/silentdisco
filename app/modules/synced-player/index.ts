import { EventEmitter, requireNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

const NativeSyncedPlayer =
  Platform.OS === "ios" ? requireNativeModule("SyncedPlayer") : null;

const emitter = NativeSyncedPlayer ? new EventEmitter(NativeSyncedPlayer) : null;

export interface PlaybackStatus {
  positionMs: number;
  isPlaying: boolean;
}

export function loadAsync(uri: string): Promise<void> {
  return NativeSyncedPlayer?.loadAsync(uri) ?? Promise.resolve();
}

export function playAsync(offsetMs: number): Promise<void> {
  return NativeSyncedPlayer?.playAsync(offsetMs) ?? Promise.resolve();
}

/** Seamless rate change — no buffer flush. Valid range: 0.25 – 4.0. */
export function setRate(rate: number): void {
  NativeSyncedPlayer?.setRate(rate);
}

export function stopAsync(): Promise<void> {
  return NativeSyncedPlayer?.stopAsync() ?? Promise.resolve();
}

export function unloadAsync(): Promise<void> {
  return NativeSyncedPlayer?.unloadAsync() ?? Promise.resolve();
}

export function addStatusListener(
  callback: (status: PlaybackStatus) => void
): { remove: () => void } {
  if (!emitter) return { remove: () => {} };
  const sub = emitter.addListener("onPlaybackStatus", callback);
  return { remove: () => sub.remove() };
}
