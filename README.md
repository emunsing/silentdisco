# silentdisco
Latency-synced mobile device bluetooth headphone listening


## Goals and context

Conventionally, silent disco experiences have used specialized hardware (one RF transmitter + single-model RF reciever/amplifier headphones) to remove differences in the latency experienced by different listeners.  Using a single local transmitter and standard hardware with very limited processing allows the music from different speakers to be synchronized to within a few milliseconds, allowing different users to experience beats at the same time, making it easy to dance in sync.

By contrast, if two users tune in to a web radio station and listen through their own devices + headphones, their respective audio experiences may be several seconds out of sync.  This latency is due to two different sources:
- Differences in server->browser latency due to differences in routing, request handling, or browser rendering
- Differences in browser -> headphone latency due to different speaker/headphone bluetooth latencies.

However, these latency issues should be surmountable:
- mobile phones have access to GPS, NTP, and NITZ servers, and thus *should* have an onboard clock which is highly accurate
- Bluetooth headphones can utilize the "Delay Reporting" element of the Bluetooth standard to report to the device what their latency is.  This can be used to adjust the device-to-headphone delay.  


## Proposed methodology

This repo creates an MVP for allowing many users with heterogeneous hardware to connect to a single music source and experience latency-synced playback, regardless of their connection latency (wifi vs. cellular) and headphone choice (wired, airpods, bluetooth headphones, bluetooth speaker).  All users should be able to dance with each other and experience the beat as being in-sync (e.g. <40ms latency gap between any two points, targeting ~20ms precision relative to the target timing).

This is similar to the problem solved by Sonos for its multi-room home speaker system.

There are two ways of accomplishing device time synchronization:
- The server sends timepoints, and the device estimates the server-to-device latency by sending a packet round-trip from the device to the server and back, and assuming the server-to-device latency is half of the round-trip.  This is likely to be inaccurateand prone to drift, and is not preferred unless we want a web-only soltion.
- Utilizing device hardware clocks, which should be synchronized through GPS/NTP/NITZ and thus should all be within a few milliseconds of each other.  This is preferred for a dedicated mobile device with access to the hardware/system clock via React Native + native OS hooks.

The synchronization of headphones/speaker should be done using the Bluetooth "Delay Reporting" functionality.  If the output device is not Bluetooth, we should assume there is no delay.

Thus, the flow is as such:
- Server sends an audio track, along with the duration of the track (in milliseconds) and the start time (in real clock time). The starting time should be ~1s ahead of the current server time.
- The device recieves the message. Based on its estimate of the delay to the headphones, it uses the device clock with maximum accuracy to start the audio track at precisely the right offset before the target track time so that the user will hear the audio start at the right time.

## Proposed architecture

Server:
- FastAPI with StreamingResponse.  Only need a single endpoint for now, which just streams the a loop of the same song (or mp3 frames of the song) with the target timepoints. Define a global variable TIME_OFFSET which is used to create the timepoints by using time.now()+TIME_OFFSET. Assume that the server clock time is correct or synchronized by the OS.

React:
- A very simple 1-button UI which triggers connect/reconnect to the server
- Poll the OS for the current accurate hardware clock time
- Poll the OS for the output audio type
- If the output is bluetooth, poll the OS for the current bluetooth delay (if it's not playing via bluetooth, assume it's zero delay)
- Compute when the next frame/chunk should start playing so that the the chunk playback start time + delay = server's target timepoint


Native modules:
- Android: 
  - Schedule audio file playback: AudioTrack or AAudio
  - Bluetooth delay: AudioTrack.getTimestamp()
- iOS: 
  - Schedule audio file playback: AVAudioEngine and AVAudioPlayerNode.scheduleFile
  - Bluetooth delay: AVAudioSession.outputLatency

# MVP

As an MVP, let's not worry about bluetooth latency.  We can stub out that function (just return 0 delay for now) for testing.