# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Voice-OpenClaw is a Discord voice bot that connects to an OpenClaw AI agent. The system captures voice from a Discord channel, transcribes it (STT), sends it to OpenClaw for a response, synthesizes the reply (TTS), and plays it back in the voice channel.

## Architecture

Four Docker services orchestrated via `docker-compose.yml`:

1. **openclaw** — The AI agent backend (pre-built image `ghcr.io/openclaw/openclaw:latest`). Uses Anthropic API (Claude Sonnet 4.6). Config lives in `openclaw/openclaw.json`. Workspace markdown files (`openclaw/workspace/*.md`) define the agent's personality, tools, and behavior. Gateway on port 18789, browser UI on 18791.

2. **stt** — Speech-to-text service (Python/FastAPI on port 8000). Uses `faster-whisper` with the "small" model on CPU (int8). Endpoint: `POST /transcribe` accepts a WAV file upload, returns `{text, language, duration}`.

3. **tts** — Text-to-speech service (Python/FastAPI on port 8001). Uses `piper-tts` CLI. Endpoint: `POST /synthesize` accepts `{text}` JSON, returns WAV binary. Model file expected at `/models/ja_JP-voice.onnx` (mounted from `./tts/models/`).

4. **discord-voice-bot** — Node.js (ES modules) bot using discord.js v14 and @discordjs/voice. Listens to voice channel audio, decodes Opus→PCM via prism-media, creates WAV, sends to STT→OpenClaw→TTS pipeline, plays response audio back. Has a `busy` lock to prevent concurrent processing. Discards audio < 0.6s. Max recording 6s per utterance. Silence detection at 0.8s.

### Data Flow

```
Discord Voice → Opus→PCM→WAV → STT(/transcribe) → text → OpenClaw(/chat) → reply text → TTS(/synthesize) → WAV → Discord Audio Player
```

## Commands

```bash
# Start all services
docker compose up -d

# Build and start (after code changes)
docker compose up -d --build

# View logs
docker compose logs -f discord-voice-bot
docker compose logs -f stt
docker compose logs -f tts

# Rebuild a single service
docker compose build stt
docker compose up -d stt
```

## Environment Variables

Copy `.env.template` to `.env` and fill in:
- `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_VOICE_CHANNEL_ID` — Discord bot config
- `STT_URL`, `TTS_URL`, `OPENCLAW_BASE_URL` — inter-service URLs (defaults use Docker service names)
- `AUTO_JOIN` — whether bot auto-joins voice channel on startup

## Key Implementation Details

- Comments and variable names are in Japanese throughout the codebase
- The OpenClaw chat endpoint (`/chat`) response format may vary; the bot tries `data.reply || data.message || data.text` as fallback
- Long replies (>220 chars) are truncated for TTS with "続きはテキストで。" appended
- Wake word detection is commented out in `discord-voice-bot/index.js` (line ~164) but can be enabled to reduce false activations
- TTS model file (`ja_JP-voice.onnx`) must be placed in `./tts/models/` before starting — it is not included in the repo

## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately – don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests – then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
