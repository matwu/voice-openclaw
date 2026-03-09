from fastapi import FastAPI, UploadFile, File
from faster_whisper import WhisperModel
import tempfile
import os
import logging

os.makedirs("/app/logs", exist_ok=True)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stt")
file_handler = logging.FileHandler("/app/logs/stt.log")
file_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
logger.addHandler(file_handler)

app = FastAPI()

# CPU最小：base / small が現実的（精度と速度のバランス）
model = WhisperModel("small", device="cpu", compute_type="int8")

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    # 入力は wav/pcm を想定（bot側でwavにします）
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(tmp_path, language="ja", vad_filter=True)
        text = "".join([s.text for s in segments]).strip()
    except ValueError:
        # VADが音声なしと判定した場合（max() arg is an empty sequence）
        logger.info("[STT] (no speech detected)")
        os.unlink(tmp_path)
        return {"text": "", "language": "", "duration": 0}

    logger.info(f"[STT] lang={info.language} dur={info.duration:.2f}s text={text!r}")
    os.unlink(tmp_path)
    return {"text": text, "language": info.language, "duration": info.duration}