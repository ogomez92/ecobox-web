#!/usr/bin/env python3
"""
Persistent Phonon (Gradium `ptts`) synthesis worker for ecobox.

Spawning the `ptts` CLI per unit costs ~2 s of model load each time; a warm model
synthesizes a sentence in a fraction of that. So the Node adapter
(src/server/services/tts/phonon.ts) keeps ONE of these alive and talks to it over
stdio, one JSON object per line:

  request  {"id": 1, "text": "...", "voice": "Zoey" | "custom:<stem>@<mtime>",
            "voicePath": "/abs/x.safetensors"?, "lang": "en", "out": "/tmp/x.wav"}
  response {"id": 1, "ok": true, "seconds": 3.2}
         | {"id": 1, "ok": false, "error": "..."}

Models are loaded lazily, one per language, and kept warm (~430 MB each):
English is the open Apache-2.0 phonon-31m-en; fr/de/es/pt are the gated
CC BY-NC phonon-40m-<lang> checkpoints (need HF_TOKEN + accepted terms).
Custom (cloned) voices are registered once per model under a key that carries the
file's mtime, so replacing the file yields a new key instead of a stale embedding.
Nothing but the JSON protocol is written to stdout.
"""
import json
import os
import sys

import ptts

MODELS = {
    "en": os.environ.get("PHONON_MODEL_EN") or None,  # None = ptts default (31m-en, pinned)
    "fr": os.environ.get("PHONON_MODEL_FR") or "hf://gradium/phonon-40m-fr",
    "de": os.environ.get("PHONON_MODEL_DE") or "hf://gradium/phonon-40m-de",
    "es": os.environ.get("PHONON_MODEL_ES") or "hf://gradium/phonon-40m-es",
    "pt": os.environ.get("PHONON_MODEL_PT") or "hf://gradium/phonon-40m-pt",
}
QUANT = os.environ.get("PHONON_QUANT") or "q8_0"

threads = int(os.environ.get("PHONON_THREADS") or 0)
if threads > 0:
    ptts.set_num_threads(threads)

_models = {}
_registered = {}  # lang -> set of custom voice keys already add_voice'd


def model_for(lang):
    if lang not in MODELS:
        raise ValueError(f"unsupported language: {lang}")
    if lang not in _models:
        path = MODELS[lang]
        _models[lang] = ptts.TTS(path, lang=lang, quant=QUANT) if path else ptts.TTS(lang=lang, quant=QUANT)
        _registered[lang] = set()
    return _models[lang]


def handle(req):
    lang = req.get("lang") or "en"
    tts = model_for(lang)
    voice = req["voice"]
    if voice.startswith("custom:"):
        if voice not in _registered[lang]:
            tts.add_voice(voice, req["voicePath"])
            _registered[lang].add(voice)
    seconds = tts.save(req["out"], req["text"], voice=voice)
    return {"ok": True, "seconds": seconds}


def main():
    # ptts may print download progress on first use; keep stdout for the protocol only.
    proto = sys.stdout
    sys.stdout = sys.stderr
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            res = handle(req)
        except Exception as e:  # report and keep serving
            res = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        res["id"] = rid
        proto.write(json.dumps(res) + "\n")
        proto.flush()


if __name__ == "__main__":
    main()
