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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [positionMs, setPositionMs] = useState(0);

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
      setAppState("syncing");

      const { sound } = await Audio.Sound.createAsync(
        { uri: `${SERVER_URL}/audio/track` },
        { shouldPlay: false }
      );
      soundRef.current = sound;

      const syncAndPlay = async () => {
        // Seek to approximate position first (warms up the MP3 decoder)
        const approxOffset =
          (Date.now() - session.loopStartTimeMs) % session.trackDurationMs;
        await sound.setPositionAsync(approxOffset);
        // Recalculate offset *after* the slow seek completes, right before play,
        // so the seek+play latency doesn't accumulate as a timing error.
        const offset =
          (Date.now() - session.loopStartTimeMs) % session.trackDurationMs;
        await sound.setPositionAsync(offset);
        await sound.playAsync();
      };

      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (!status.isLoaded) return;
        setPositionMs(status.positionMillis);
        if (status.didJustFinish) {
          // Re-sync to wall clock on every loop restart rather than blindly
          // seeking to 0 — prevents timing errors from compounding each loop.
          syncAndPlay();
        }
      });

      // Get position updates as fast as expo-av will give them
      await sound.setProgressUpdateIntervalAsync(16);

      await syncAndPlay();
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
