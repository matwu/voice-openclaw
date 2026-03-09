from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
import edge_tts
import tempfile
import os
import subprocess

app = FastAPI()

# 日本語音声: ja-JP-NanamiNeural(女性), ja-JP-KeitaNeural(男性)
VOICE = os.environ.get("TTS_VOICE", "ja-JP-NanamiNeural")

class Req(BaseModel):
    text: str

@app.post("/synthesize")
async def synthesize(req: Req):
    text = req.text.strip()
    if not text:
        return {"error": "empty text"}

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as mp3_file:
        mp3_path = mp3_file.name
    wav_path = mp3_path.replace(".mp3", ".wav")

    try:
        # edge-ttsでMP3生成
        communicate = edge_tts.Communicate(text, VOICE)
        await communicate.save(mp3_path)

        # MP3→WAV変換（discord.jsのcreateAudioResourceが扱いやすい）
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", mp3_path, "-ar", "48000", "-ac", "1", "-f", "wav", wav_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False
        )
        if result.returncode != 0:
            return {"error": f"ffmpeg error: {result.stderr.decode()[:500]}"}

        with open(wav_path, "rb") as f:
            data = f.read()

        return Response(content=data, media_type="audio/wav")
    finally:
        for p in [mp3_path, wav_path]:
            try:
                os.unlink(p)
            except OSError:
                pass
