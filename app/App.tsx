import * as FileSystem from "expo-file-system/legacy";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { fetchSession, SERVER_URL } from "./src/api";
import { getOutputLatencyMs } from "./modules/audio-latency";
import * as SyncedPlayer from "./modules/synced-player";

type AppState = "idle" | "loading" | "syncing" | "playing" | "error";

const DEVICE_ID = Math.random().toString(36).slice(2, 6).toUpperCase();

function formatPosition(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = (totalSec % 60).toString().padStart(2, "0");
  const mil = (ms % 1000).toString().padStart(3, "0");
  return `${min}:${sec}.${mil}`;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const trackDurationMsRef = useRef(0);
  const loopStartMsRef = useRef(0);
  const [positionMs, setPositionMs] = useState(0);
  const [displayRate, setDisplayRate] = useState(1.0);
  const [latencyMs, setLatencyMs] = useState(0);
  const outputLatencyRef = useRef(0);
  const isSyncingRef = useRef(false);
  const currentRateRef = useRef(1.0);
  const lastRateChangeTimeRef = useRef(0);
  const statusSubRef = useRef<{ remove: () => void } | null>(null);

  // Poll output latency every 2s — picks up headphone/BT changes automatically.
  // Only update the ref when the value shifts significantly (>10ms),
  // to avoid drift correction reacting to minor fluctuations.
  useEffect(() => {
    const poll = () => {
      const ms = getOutputLatencyMs();
      setLatencyMs(ms);
      if (Math.abs(ms - outputLatencyRef.current) > 10) {
        outputLatencyRef.current = ms;
      }
    };
    poll();
    // On first read, always set it
    outputLatencyRef.current = getOutputLatencyMs();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      statusSubRef.current?.remove();
      SyncedPlayer.stopAsync();
      SyncedPlayer.unloadAsync();
    };
  }, []);

  async function connect() {
    try {
      setAppState("loading");
      setErrorMsg("");

      const session = await fetchSession();
      trackDurationMsRef.current = session.trackDurationMs;
      loopStartMsRef.current = session.loopStartTimeMs;
      setAppState("syncing");

      // Download audio to local cache so AVAudioFile can read it.
      const localUri = FileSystem.cacheDirectory + "track.mp3";
      await FileSystem.downloadAsync(`${SERVER_URL}/audio/track`, localUri);

      // Load into AVAudioEngine (in-memory PCM buffer).
      await SyncedPlayer.loadAsync(localUri);

      const hardSync = async () => {
        isSyncingRef.current = true;
        const latency = outputLatencyRef.current;
        const offset =
          (Date.now() + latency - session.loopStartTimeMs) % session.trackDurationMs;
        currentRateRef.current = 1.0;
        SyncedPlayer.setRate(1.0);
        await SyncedPlayer.playAsync(offset);
        isSyncingRef.current = false;
      };

      // Drift correction via playback rate adjustment.
      // Small drift: nudge AVAudioUnitVarispeed.rate to close the gap — seamless,
      // no buffer flush, no audible gap.
      // Large drift: hard re-seek via playAsync (audible but rare).
      const NUDGE_START_MS = 50;
      const NUDGE_STOP_MS = 15;
      const HARD_DRIFT_THRESHOLD_MS = 1500;
      const RATE_NUDGE = 0.03;

      // After a rate change, AVAudioEngine can fire several status callbacks
      // with stale position data. Ignore drift decisions for a short window.
      const RATE_CHANGE_COOLDOWN_MS = 1000;
      const setRateIfChanged = (rate: number) => {
        if (currentRateRef.current !== rate) {
          currentRateRef.current = rate;
          lastRateChangeTimeRef.current = Date.now();
          setDisplayRate(rate);
          SyncedPlayer.setRate(rate); // synchronous DSP param change, no await
        }
      };

      statusSubRef.current?.remove();
      statusSubRef.current = SyncedPlayer.addStatusListener((status) => {
        if (!status.isPlaying || status.positionMs < 0) return;
        setPositionMs(status.positionMs);

        if (isSyncingRef.current) return;
        if (Date.now() - lastRateChangeTimeRef.current < RATE_CHANGE_COOLDOWN_MS) return;

        const now = Date.now();
        const expectedPos =
          (now + outputLatencyRef.current - loopStartMsRef.current) % trackDurationMsRef.current;
        let drift = status.positionMs - expectedPos;
        // Handle wraparound at track boundary
        const half = trackDurationMsRef.current / 2;
        if (drift > half) drift -= trackDurationMsRef.current;
        if (drift < -half) drift += trackDurationMsRef.current;

        console.log(
          `[${DEVICE_ID}] pos=${status.positionMs.toFixed(0)} exp=${Math.round(expectedPos)} drift=${Math.round(drift)} rate=${currentRateRef.current}`
        );

        if (Math.abs(drift) >= HARD_DRIFT_THRESHOLD_MS) {
          hardSync();
        } else if (Math.abs(drift) > NUDGE_START_MS) {
          const targetRate = drift > 0 ? 1.0 - RATE_NUDGE : 1.0 + RATE_NUDGE;
          setRateIfChanged(targetRate);
        } else if (Math.abs(drift) < NUDGE_STOP_MS) {
          setRateIfChanged(1.0);
        }
        // Between NUDGE_STOP and NUDGE_START: keep current rate (no change)
      });

      await hardSync();
      setAppState("playing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setAppState("error");
    }
  }

  async function disconnect() {
    statusSubRef.current?.remove();
    statusSubRef.current = null;
    await SyncedPlayer.stopAsync();
    await SyncedPlayer.unloadAsync();
    setPositionMs(0);
    trackDurationMsRef.current = 0;
    loopStartMsRef.current = 0;
    setAppState("idle");
  }

  const isConnected = appState === "playing";
  const isBusy = appState === "loading" || appState === "syncing";

  const buttonLabel =
    appState === "idle" || appState === "error"
      ? "Connect"
      : appState === "loading"
      ? "Loading…"
      : appState === "syncing"
      ? "Syncing…"
      : "Disconnect";

  const statusText =
    appState === "idle"
      ? "Tap to join the disco"
      : appState === "loading"
      ? "Fetching session…"
      : appState === "syncing"
      ? "Syncing audio…"
      : appState === "playing"
      ? "In sync"
      : `Error: ${errorMsg}`;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.debugPanel}>
        <Text style={styles.debugLabel}>track pos</Text>
        <Text style={styles.debugValue}>{formatPosition(positionMs)}</Text>
        <Text style={styles.debugLabel}>rate</Text>
        <Text style={styles.debugValue}>{displayRate.toFixed(2)}x</Text>
        <Text style={styles.debugLabel}>output latency</Text>
        <Text style={styles.debugValue}>{latencyMs.toFixed(1)}ms</Text>
      </View>

      <Text style={styles.title}>silent disco</Text>
      <Pressable
        style={[
          styles.button,
          isConnected && styles.buttonConnected,
          isBusy && styles.buttonBusy,
        ]}
        onPress={isConnected ? disconnect : isBusy ? undefined : connect}
        disabled={isBusy}
      >
        {isBusy ? (
          <ActivityIndicator color="#fff" size="large" />
        ) : (
          <Text style={styles.buttonText}>{buttonLabel}</Text>
        )}
      </Pressable>
      <Text style={[styles.status, appState === "error" && styles.statusError]}>
        {statusText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
    alignItems: "center",
    justifyContent: "center",
    gap: 32,
  },
  debugPanel: {
    alignItems: "center",
    gap: 4,
  },
  debugLabel: {
    color: "#555",
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  debugValue: {
    color: "#0f0",
    fontSize: 22,
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
    fontFamily: "monospace",
  },
  title: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "300",
    letterSpacing: 8,
    textTransform: "lowercase",
  },
  button: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "#1a1a2e",
    borderWidth: 2,
    borderColor: "#4a4aff",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonConnected: {
    backgroundColor: "#0d1b0d",
    borderColor: "#4aff4a",
  },
  buttonBusy: {
    borderColor: "#888",
  },
  buttonText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: 1,
  },
  status: {
    color: "#888",
    fontSize: 14,
    letterSpacing: 1,
  },
  statusError: {
    color: "#ff4a4a",
  },
});
