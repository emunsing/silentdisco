export const SERVER_URL = "http://192.168.0.134:8000";

export interface Session {
  trackDurationMs: number;
  loopStartTimeMs: number;
  serverTimeMs: number;
}

export async function fetchSession(): Promise<Session> {
  const res = await fetch(`${SERVER_URL}/api/session`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  const data = await res.json();
  return {
    trackDurationMs: data.track_duration_ms,
    loopStartTimeMs: data.loop_start_time_ms,
    serverTimeMs: data.server_time_ms,
  };
}
