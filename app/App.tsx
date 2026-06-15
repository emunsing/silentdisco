import { Audio, AVPlaybackStatus } from "expo-av";
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

type AppState = "idle" | "loading" | "syncing" | "playing" | "error";

function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds().toString().padStart(2, "0");
  const mil = d.getMilliseconds().toString().padStart(3, "0");
  return `${h}:${m}:${s}.${mil}`;
}

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
  const soundRef = useRef<Audio.Sound | null>(null);
  const trackDurationMsRef = useRef(0);
  const loopStartMsRef = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [positionMs, setPositionMs] = useState(0);
  const isSyncingRef = useRef(false);
  const currentRateRef = useRef(1.0);

  // Live clock — update every 16ms (~60fps)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 16);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync();
    };
  }, []);

  async function connect() {
    try {
      setAppState("loading");
      setErrorMsg("");

      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
      });

      const session = await fetchSession();
      trackDurationMsRef.current = session.trackDurationMs;
      loopStartMsRef.current = session.loopStartTimeMs;
      setAppState("syncing");

      const { sound } = await Audio.Sound.createAsync(
        { uri: `${SERVER_URL}/audio/track` },
        { shouldPlay: false }
      );
      soundRef.current = sound;

      const hardSync = async () => {
        const approxOffset =
          (Date.now() - session.loopStartTimeMs) % session.trackDurationMs;
        await sound.setPositionAsync(approxOffset);
        const offset =
          (Date.now() - session.loopStartTimeMs) % session.trackDurationMs;
        await sound.setPositionAsync(offset);
        await sound.setRateAsync(1.0, true);
        await sound.playAsync();
      };

      // Drift correction via playback rate adjustment.
      // Small drift (<200ms): nudge rate to 0.98 or 1.02 to close the gap.
      // Large drift (>=200ms): hard re-seek (unavoidable gap, but rare).
      const SOFT_DRIFT_THRESHOLD_MS = 30;
      const HARD_DRIFT_THRESHOLD_MS = 200;
      const RATE_NUDGE = 0.02;

      // Track desired rate locally to avoid redundant setRateAsync calls
      const setRateIfChanged = async (rate: number) => {
        if (currentRateRef.current !== rate) {
          currentRateRef.current = rate;
          await sound.setRateAsync(rate, true);
        }
      };

      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (!status.isLoaded || !status.isPlaying) return;
        setPositionMs(status.positionMillis);

        if (status.didJustFinish) {
          hardSync();
          return;
        }

        if (isSyncingRef.current) return;

        const now = Date.now();
        const wallClockPos =
          (now - loopStartMsRef.current) % trackDurationMsRef.current;
        const drift = status.positionMillis - wallClockPos;

        if (Math.abs(drift) >= HARD_DRIFT_THRESHOLD_MS) {
          isSyncingRef.current = true;
          hardSync().finally(() => {
            isSyncingRef.current = false;
          });
        } else if (Math.abs(drift) > SOFT_DRIFT_THRESHOLD_MS) {
          const targetRate = drift > 0 ? 1.0 - RATE_NUDGE : 1.0 + RATE_NUDGE;
          setRateIfChanged(targetRate);
        } else {
          setRateIfChanged(1.0);
        }
      });

      // Check drift every 500ms — frequent enough to correct, rare enough
      // to not interfere with audio playback
      await sound.setProgressUpdateIntervalAsync(500);

      await hardSync();
      setAppState("playing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setAppState("error");
    }
  }

  async function disconnect() {
    if (soundRef.current) {
      await soundRef.current.stopAsync();
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
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
        <Text style={styles.debugLabel}>clock</Text>
        <Text style={styles.debugValue}>{formatClock(nowMs)}</Text>
        <Text style={styles.debugLabel}>track pos</Text>
        <Text style={styles.debugValue}>{formatPosition(positionMs)}</Text>
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
