import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from mutagen.mp3 import MP3

TRACK_PATH = Path(__file__).parent.parent / "data" / "99440__kara__hiphop_fs_loop1.mp3"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

audio = MP3(TRACK_PATH)
TRACK_DURATION_MS = int(audio.info.length * 1000)
print(f"Track duration: {TRACK_DURATION_MS}ms ({audio.info.length:.2f}s)")


@app.get("/api/session")
def get_session():
    now_ms = int(time.time() * 1000)
    loop_start_ms = (now_ms // TRACK_DURATION_MS) * TRACK_DURATION_MS
    return {
        "track_duration_ms": TRACK_DURATION_MS,
        "loop_start_time_ms": loop_start_ms,
        "server_time_ms": now_ms,
    }


@app.get("/audio/track")
def get_track():
    return FileResponse(
        TRACK_PATH,
        media_type="audio/mpeg",
        headers={"Accept-Ranges": "bytes"},
    )
