#!/usr/bin/env bash
# Re-download the on-device voice assets (kept out of git — too big).
# Jarvis = jgkawell/jarvis en_GB/high (community-trained Iron Man JARVIS voice).
set -euo pipefail
cd "$(dirname "$0")/../data"
mkdir -p local-voices/jarvis && cd local-voices

BASE="https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/high"
echo "fetching Iron Man Jarvis (en_GB high)..."
curl -sL -o jarvis/model.onnx   "$BASE/jarvis-high.onnx"
curl -sL -o jarvis/config.json  "$BASE/jarvis-high.onnx.json"
curl -sL -o jarvis/sample.mp3   "$BASE/samples/speaker_0.mp3"

# tokens.txt from the Piper phoneme_id_map (sherpa "<symbol> <id>" format).
python3 - <<'PY'
import json
c = json.load(open('jarvis/config.json'))
with open('jarvis/tokens.txt', 'w') as f:
    for sym, ids in c['phoneme_id_map'].items():
        for i in ids:
            f.write(f"{sym} {i}\n")
PY

# CRITICAL: bake the ONNX metadata sherpa-onnx requires (the community model
# ships WITHOUT it, which makes sherpa's native Init abort — on Android that
# SIGABRT crashes the whole app). Values come from the Piper config.
python3 - <<'PY'
import onnx, json
cfg = json.load(open('jarvis/config.json'))
meta = {
    "model_type": "vits",
    "comment": "piper",
    "language": "English",
    "voice": cfg.get('espeak', {}).get('voice', 'en-gb-x-rp'),
    "has_espeak": "1",
    "n_speakers": str(cfg.get('num_speakers', 1)),
    "sample_rate": str(cfg['audio']['sample_rate']),
}
m = onnx.load("jarvis/model.onnx", load_external_data=False)
while len(m.metadata_props): m.metadata_props.pop()
for k, v in meta.items():
    e = m.metadata_props.add(); e.key = k; e.value = str(v)
onnx.save(m, "jarvis/model.onnx")
print("baked sherpa metadata:", meta)
PY

echo "fetching espeak-ng-data..."
curl -sL -o /tmp/espeak-ng-data.tar.bz2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2"
tar xjf /tmp/espeak-ng-data.tar.bz2 -C /tmp/
(cd /tmp && zip -qr espeak-ng-data.zip espeak-ng-data)
mv -f /tmp/espeak-ng-data.zip .
echo "done: $(du -sh jarvis espeak-ng-data.zip)"
echo "tip: validate with  pip install sherpa-onnx onnx  then a quick OfflineTts.generate()"
