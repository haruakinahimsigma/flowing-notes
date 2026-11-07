import io
import os
import threading
import time

import librosa
import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from piano_transcription_inference import PianoTranscription, sample_rate

app = FastAPI(title="Flowing Notes Piano AI", version="2.0.0")
model = None
model_lock = threading.Lock()
MAX_UPLOAD_BYTES = 150 * 1024 * 1024

@app.on_event("startup")
def load_model():
    global model
    torch.set_num_threads(max(1, int(os.getenv("TORCH_NUM_THREADS", "2"))))
    torch.set_num_interop_threads(1)
    device = "cuda" if torch.cuda.is_available() and os.getenv("USE_CUDA", "0") == "1" else "cpu"
    model = PianoTranscription(device=device, checkpoint_path=os.getenv("PIANO_CHECKPOINT") or None)
    print(f"Flowing Notes Kong piano model loaded on {device}.", flush=True)

@app.get("/health")
def health():
    return {"ok": model is not None, "model": "Kong high-resolution piano transcription", "sampleRate": sample_rate}

def transcribe_audio(payload: bytes):
    if model is None:
        raise HTTPException(status_code=503, detail="Piano AI model is still loading.")
    try:
        audio, _ = librosa.load(io.BytesIO(payload), sr=sample_rate, mono=True)
        audio = np.asarray(audio, dtype=np.float32)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode audio: {exc}") from exc
    if audio.size < sample_rate:
        raise HTTPException(status_code=400, detail="Audio must be at least one second long.")
    if not np.isfinite(audio).all():
        raise HTTPException(status_code=400, detail="Audio contains invalid sample values.")
    try:
        started = time.perf_counter()
        with model_lock, torch.inference_mode():
            result = model.transcribe(audio, midi_path=None)
        note_events = result.get("est_note_events") or []
        pedal_events = result.get("est_pedal_events") or []
        notes = []
        for note in note_events:
            pitch = int(note["midi_note"])
            start = max(0.0, float(note["onset_time"]))
            end = float(note["offset_time"])
            velocity = max(1, min(127, int(note.get("velocity", 80))))
            if 21 <= pitch <= 108 and end > start:
                notes.append({
                    "pitchMidi": pitch,
                    "startTimeSeconds": start,
                    "durationSeconds": end - start,
                    "amplitude": velocity / 127.0,
                    "velocity": velocity
                })
        pedals = []
        for pedal in pedal_events:
            start = max(0.0, float(pedal["onset_time"]))
            end = float(pedal["offset_time"])
            if end > start:
                pedals.append({"startTimeSeconds": start, "endTimeSeconds": end})
        notes.sort(key=lambda item: item["startTimeSeconds"])
        pedals.sort(key=lambda item: item["startTimeSeconds"])
        if not notes:
            raise HTTPException(status_code=422, detail="No clear piano notes were detected. Try a cleaner, piano-focused recording.")
        return {
            "model": "Kong high-resolution piano transcription",
            "notes": notes,
            "pedalEvents": pedals,
            "duration": float(audio.size / sample_rate),
            "inferenceSeconds": round(time.perf_counter() - started, 3)
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Piano inference error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="Piano AI could not process this recording.") from exc

@app.post("/transcribe")
async def transcribe(request: Request):
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio exceeds the 150 MB upload limit.")
    return await run_in_threadpool(transcribe_audio, payload)
