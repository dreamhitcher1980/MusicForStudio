"""
Local MusicGen server for MusicForStudio.

Wraps Meta's open-source "MusicGen" model (via Hugging Face `transformers`) and
exposes a tiny HTTP API that the studio calls to generate real neural audio.
Everything runs on YOUR machine — nothing is uploaded anywhere. Combined with
the on-device engine in the browser app, this is the "real AI" option in
Settings → Local MusicGen server.

Quick start
-----------
    pip install -r requirements.txt
    python musicgen_server.py                    # default: facebook/musicgen-small
    python musicgen_server.py --model facebook/musicgen-medium   # better quality, heavier

Then in MusicForStudio → Settings, turn on "Use the local MusicGen server"
(URL default http://127.0.0.1:7860) and hit "Test connection".

First run downloads the model weights from Hugging Face (~1–3 GB depending on
size) into ~/.cache/huggingface. A GPU (CUDA) is strongly recommended —
on CPU a 24-second generation can take several minutes.

API
---
    GET  /api/health
        -> {"ok": true, "model": "...", "cuda": true|false}

    POST /api/generate     body: {"prompt": str, "duration": 24, "seed": 0}
        -> audio/wav  (mono, model sample rate; ~50 tokens/sec of audio)
"""

import argparse
import io
import wave

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from transformers import AutoProcessor, MusicgenForConditionalGeneration
import uvicorn

app = FastAPI(title='MusicForStudio MusicGen')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

MODEL_ID = 'facebook/musicgen-small'
TOKENS_PER_SECOND = 50

MODEL = None
PROCESSOR = None
DEVICE = 'cpu'


class GenerateRequest(BaseModel):
    prompt: str = ''
    duration: float = 24.0
    seed: int = 0


@app.on_event('startup')
def _load_model():
    global MODEL, PROCESSOR, DEVICE
    DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
    PROCESSOR = AutoProcessor.from_pretrained(MODEL_ID)
    MODEL = MusicgenForConditionalGeneration.from_pretrained(MODEL_ID)
    if DEVICE == 'cuda':
        MODEL.to('cuda')
    print(f'[musicgen] loaded {MODEL_ID} on {DEVICE}')


@app.get('/api/health')
def health():
    return {'ok': True, 'model': MODEL_ID, 'cuda': DEVICE == 'cuda'}


@app.post('/api/generate')
def generate(req: GenerateRequest):
    if MODEL is None or PROCESSOR is None:
        raise HTTPException(status_code=503, detail='model not loaded yet')

    torch.manual_seed(req.seed)
    inputs = PROCESSOR(text=[req.prompt or 'a song'], padding=True, return_tensors='pt').to(DEVICE)
    max_new_tokens = max(1, int(round(req.duration * TOKENS_PER_SECOND)))

    with torch.no_grad():
        audio = MODEL.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=True,
            temperature=1.0,
            top_k=250,
        )
    # audio is (batch, channels, samples) — take the first channel of take 0.
    waveform = audio[0, 0].cpu().float().numpy()
    sample_rate = int(MODEL.config.audio_encoder.sampling_rate)

    with io.BytesIO() as buf:
        with wave.open(buf, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes((waveform * 32767).clip(-32767, 32767).astype('int16').tobytes())
        data = buf.getvalue()

    return Response(content=data, media_type='audio/wav')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Local MusicGen server for MusicForStudio')
    parser.add_argument('--model', default=MODEL_ID, help='Hugging Face MusicGen model id')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', default=7860, type=int)
    args = parser.parse_args()
    MODEL_ID = args.model
    uvicorn.run(app, host=args.host, port=args.port)
