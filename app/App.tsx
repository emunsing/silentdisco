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
import { getOutputLatencyMs } from "./modules/audio-latency";

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
  const soundRef = useRef<Audio.Sound | null>(null);
  const trackDurationMsRef = useRef(0);
  const loopStartMsRef = useRef(0);
  const [positionMs, setPositionMs] = useState(0);
  const [displayRate, setDisplayRate] = useState(1.0);
  const [latencyMs, setLatencyMs] = useState(0);
  const outputLatencyRef = useRef(0);
  const isSyncingRef = useRef(false);
  const currentRateRef = useRef(1.0);
  const lastRateChangeTimeRef = useRef(0);
  // PI controller state
  const integralRateRef = useRef(0);      // learned baseline rate offset (compensates clock drift)
  const smoothedDriftRateRef = useRef(0); // EMA of drift rate in ms/sec
  const prevDriftRef = useRef<number | null>(null);
  const prevCallbackTimeRef = useRef(Date.now());

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
        { shouldPlay: false, isLooping: true }
      );
      soundRef.current = sound;

      const hardSync = async () => {
        isSyncingRef.current = true;
        const latency = outputLatencyRef.current;
        const offset =
          (Date.now() + latency - session.loopStartTimeMs) % session.trackDurationMs;
        await sound.setPositionAsync(offset);
        currentRateRef.current = 1.0;
        await sound.setRateAsync(1.0, false);
        await sound.playAsync();
        isSyncingRef.current = false;
      };

      // PI rate controller.
      //
      // P term: multi-level discrete correction. Three bands give fast convergence
      // from large drifts while keeping rate changes infrequent.
      //
      // I term: EMA of the observed drift rate (ms/sec), measured only while in
      // the dead band so P-term corrections don't contaminate the estimate. Once
      // learned, the integral offsets the baseline rate to cancel the device's
      // persistent clock error, meaning P rarely needs to fire in steady state.
      //
      // Quantised to 0.5% steps so the integral accumulates silently until it
      // crosses a threshold, limiting how often setRateAsync is called.
      const DEAD_BAND_MS = 10;
      const P_MEDIUM_MS = 50;
      const P_LARGE_MS = 200;
      const HARD_DRIFT_THRESHOLD_MS = 1500;
      const P_SMALL_RATE = 0.01;
      const P_MEDIUM_RATE = 0.03;
      const P_LARGE_RATE = 0.06;
      const INTEGRAL_ALPHA = 0.025;   // EMA decay; ~10-callback (~5s) time constant
      const INTEGRAL_MAX = 0.03;    // cap integral at ±3%
      const QUANTIZE_STEP = 0.001;  // only apply rate changes in 0.1% increments
      const RATE_CHANGE_COOLDOWN_MS = 1000;

      // Only call setRateAsync when the rate actually changes, and record the
      // time so the cooldown can suppress the phantom-drift callback burst.
      const setRateIfChanged = async (rate: number) => {
        if (currentRateRef.current !== rate) {
          currentRateRef.current = rate;
          lastRateChangeTimeRef.current = Date.now();
          setDisplayRate(rate);
          await sound.setRateAsync(rate, false);
        }
      };

      sound.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
        if (!status.isLoaded || !status.isPlaying) return;
        setPositionMs(status.positionMillis);

        if (isSyncingRef.current) return;

        const now = Date.now();

        // During cooldown after a rate change, AVPlayer fires phantom callbacks
        // with stale position data. Discard them and invalidate prevDrift so the
        // integral doesn't learn from readings that straddle a rate change.
        if (now - lastRateChangeTimeRef.current < RATE_CHANGE_COOLDOWN_MS) {
          prevDriftRef.current = null;
          return;
        }

        const expectedPos =
          (now + outputLatencyRef.current - loopStartMsRef.current) % trackDurationMsRef.current;
        let drift = status.positionMillis - expectedPos;
        const half = trackDurationMsRef.current / 2;
        if (drift > half) drift -= trackDurationMsRef.current;
        if (drift < -half) drift += trackDurationMsRef.current;

        // dt since last accepted callback (excludes cooldown gaps).
        // prevCallbackTimeRef is only updated below, so a long gap (cooldown)
        // gives dt > 1.5s and prevents a stale integral update.
        const dt = (now - prevCallbackTimeRef.current) / 1000;

        // Proportional term — multi-level discrete correction.
        let proportional = 0;
        if (Math.abs(drift) >= HARD_DRIFT_THRESHOLD_MS) {
          hardSync();
          prevDriftRef.current = null;
          prevCallbackTimeRef.current = now;
          return;
        } else if (Math.abs(drift) > P_LARGE_MS) {
          proportional = drift < 0 ? P_LARGE_RATE : -P_LARGE_RATE;
        } else if (Math.abs(drift) > P_MEDIUM_MS) {
          proportional = drift < 0 ? P_MEDIUM_RATE : -P_MEDIUM_RATE;
        } else if (Math.abs(drift) > DEAD_BAND_MS) {
          proportional = drift < 0 ? P_SMALL_RATE : -P_SMALL_RATE;
        }

        // Integral term — update only in the dead band with valid consecutive readings.
        // This ensures we measure the natural clock drift rate, not correction artefacts.
        if (
          proportional === 0 &&
          prevDriftRef.current !== null &&
          dt > 0.3 && dt < 1.5
        ) {
          const driftRateMs = (drift - prevDriftRef.current) / dt; // ms/sec
          smoothedDriftRateRef.current =
            (1 - INTEGRAL_ALPHA) * smoothedDriftRateRef.current +
            INTEGRAL_ALPHA * driftRateMs;
          // Convert drift rate to rate offset: falling behind → speed up → positive offset.
          integralRateRef.current = Math.max(
            -INTEGRAL_MAX,
            Math.min(INTEGRAL_MAX, -smoothedDriftRateRef.current / 1000)
          );
        }

        // Combine P + I and quantise to limit setRateAsync call frequency.
        const rawRate = 1.0 + integralRateRef.current + proportional;
        const quantizedRate =
          Math.round(rawRate / QUANTIZE_STEP) * QUANTIZE_STEP;

        console.log(
          `[${DEVICE_ID}] pos=${status.positionMillis} exp=${Math.round(expectedPos)} ` +
          `drift=${Math.round(drift)} p=${proportional.toFixed(2)} ` +
          `i=${integralRateRef.current.toFixed(4)} rate=${quantizedRate.toFixed(3)}`
        );

        // Null prevDrift on rate change so the integral doesn't learn across
        // a boundary where the cooldown will suppress intermediate callbacks.
        if (quantizedRate !== currentRateRef.current) {
          prevDriftRef.current = null;
        } else {
          prevDriftRef.current = drift;
        }
        prevCallbackTimeRef.current = now;

        setRateIfChanged(quantizedRate);
      });

      // Check drift every 500ms
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
    setDisplayRate(1.0);
    trackDurationMsRef.current = 0;
    loopStartMsRef.current = 0;
    integralRateRef.current = 0;
    smoothedDriftRateRef.current = 0;
    prevDriftRef.current = null;
    currentRateRef.current = 1.0;
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
        <Text style={styles.debugValue}>{displayRate.toFixed(3)}x</Text>
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
