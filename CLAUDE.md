# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**silentdisco** is a latency-synced silent disco system allowing heterogeneous mobile devices + headphones to experience music in sync (target: <40ms gap between any two listeners, ~20ms precision). It is analogous to what Sonos does for multi-room audio, but for a live event setting.

The core insight: mobile phones have accurate hardware clocks (GPS/NTP/NITZ), so synchronization should be achieved by having all devices schedule playback relative to a shared wall-clock time rather than trying to estimate server-to-device latency.

## Planned Architecture

### Server (Python / FastAPI)
- Single FastAPI endpoint using `StreamingResponse` to stream an MP3 loop
- Each response includes the audio track, its duration (ms), and a **target start time** (`time.now() + TIME_OFFSET`, where `TIME_OFFSET` ≈ 1 second ahead)
- Assumes the server OS clock is accurate

Sample audio: `data/99440__kara__hiphop_fs_loop1.mp3`

### Mobile App (React Native)
- Minimal UI: one button to connect/reconnect to the server
- Reads the device hardware clock with maximum accuracy
- Reads current audio output type (wired / bluetooth / speaker)
- For bluetooth output: reads the bluetooth delay via native module (stubbed to `0` for MVP)
- Schedules each audio chunk to start at: `target_timepoint - bluetooth_delay`

### Native Modules
| Platform | Audio Scheduling | Bluetooth Delay |
|----------|-----------------|-----------------|
| Android  | `AudioTrack` or `AAudio` | `AudioTrack.getTimestamp()` |
| iOS      | `AVAudioEngine` + `AVAudioPlayerNode.scheduleFile` | `AVAudioSession.outputLatency` |

## MVP Scope

Bluetooth latency compensation is **stubbed out** (return `0`) for the initial implementation. The MVP focuses on clock-based synchronization only.

## Commands

### Server
```bash
cd server && pip install -r requirements.txt && uvicorn main:app --reload
```

### App
```bash
cd app && npm install && npx expo start
```

> **Physical device**: change `SERVER_URL` in `app/src/api.ts` from `localhost` to your machine's LAN IP (e.g. `http://192.168.1.42:8000`) before running on a real device.
