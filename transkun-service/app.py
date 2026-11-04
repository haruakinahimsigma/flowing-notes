import io
import os
import threading
from pathlib import Path

import numpy as np
import soxr
import torch
import moduleconf
import pkg_resources
from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from scipy.io import wavfile

app = FastAPI(title="Flowing Notes Transkun V2")
model = None
inference_lock = threading.Lock()
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

@app.on_event("startup")
def load_model():
    global model
    torch.set_num_threads(max(1, int(os.getenv("TORCH_NUM_THREADS", "2"))))
    torch.set_num_interop_threads(1)
    conf_path = pkg_resources.resource_filename("transkun", "pretrained/2.0.conf")
    weight_path = pkg_resources.resource_filename("transkun", "pretrained/2.0.pt")
    manager = moduleconf.parseFromFile(conf_path)
    TransKun = manager["Model"].module.TransKun
    config = manager["Model"].config
    checkpoint = torch.load(weight_path, map_location="cpu", weights_only=False)
    model_instance = TransKun(conf=config).to("cpu")
    state = checkpoint.get("best_state_dict", checkpoint.get("state_dict"))
    if state is None:
        raise RuntimeError("Transkun checkpoint does not contain model weights.")
    model_instance.load_state_dict(state, strict=False)
    model_instance.eval()
    model = model_instance
    print("Transkun V2 CPU model loaded and ready.", flush=True)

@app.get("/health")
def health():
    return {"ok": model is not None, "model": "Transkun V2"}

def run_transcription(payload: bytes, filename: str):
    global model
    if model is None:
        raise HTTPException(status_code=503, detail="Transkun model is still loading.")
    suffix = Path(filename or "recording.wav").suffix.lower().lstrip(".")
    allowed = {"wav", "mp3", "m4a", "aac", "ogg", "flac", "aiff", "aif"}
    fmt = suffix if suffix in allowed else None
    try:
        sample_rate, samples = wavfile.read(io.BytesIO(payload))
        if samples.ndim > 1:
            samples = samples.astype(np.float32).mean(axis=1)
        if np.issubdtype(samples.dtype, np.integer):
            info = np.iinfo(samples.dtype)
            scale = float(max(abs(info.min), info.max))
            samples = samples.astype(np.float32) / scale
        else:
            samples = samples.astype(np.float32)
        samples = samples.reshape(-1, 1)
        if sample_rate != model.fs:
            samples = soxr.resample(samples, sample_rate, model.fs)
        audio = torch.from_numpy(np.asarray(samples, dtype=np.float32))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode the audio file: {exc}") from exc

    if audio.shape[0] < model.fs:
        raise HTTPException(status_code=400, detail="Audio must be at least one second long.")

    try:
        with inference_lock, torch.inference_mode():
            estimated = model.transcribe(audio, stepInSecond=4, segmentSizeInSecond=8, discardSecondHalf=False)
        output = []
        for note in estimated:
            pitch = int(note.pitch)
            if 21 <= pitch <= 108 and note.end > note.start:
                velocity = max(1, min(127, int(round(float(note.velocity)))))
                output.append({
                    "pitchMidi": pitch,
                    "startTimeSeconds": max(0.0, float(note.start)),
                    "durationSeconds": max(0.001, float(note.end - note.start)),
                    "amplitude": velocity / 127.0
                })
        output.sort(key=lambda item: item["startTimeSeconds"])
        if not output:
            raise HTTPException(status_code=422, detail="Transkun did not detect clear piano notes in this recording.")
        return {"model": "Transkun V2", "notes": output}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Transkun inference error: {exc}", flush=True)
        raise HTTPException(status_code=500, detail="Transkun could not process this recording.") from exc

@app.post("/transcribe")
async def transcribe(request: Request):
    payload = await request.body()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio file exceeds the 100 MB upload limit.")
    filename = request.headers.get("x-file-name", "recording.wav")
    return await run_in_threadpool(run_transcription, payload, filename)
