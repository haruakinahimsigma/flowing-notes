# Flowing Notes Piano AI service

This service replaces the retired Transkun integration with the Kong et al. high-resolution piano transcription inference package.

## Railway deployment

Create a separate Railway service from this same repository and set its **Root Directory** to `/piano-service`. Railway will build the included Dockerfile. The first startup downloads the pretrained checkpoint (about 165 MB), so the initial health check can take several minutes.

Set:
- `TORCH_NUM_THREADS=2` (adjust to available CPU)
- Health check path: `/health`

On the existing Flowing Notes API service, set `PIANO_AI_URL` to the private URL of this service, for example `http://piano-ai.railway.internal:8000`.

The API accepts raw audio bytes at `POST /transcribe` and returns note events, MIDI velocity, and sustain-pedal events. It is designed for CPU inference; a GPU is optional and is not assumed by this Dockerfile.

## Model

Kong et al., *High-resolution Piano Transcription with Pedals by Regressing Onsets and Offsets Times* (2020). The inference package downloads its published pretrained checkpoint from Zenodo on first startup. The package is MIT-licensed; check the upstream project and checkpoint terms before redistributing model artifacts.
