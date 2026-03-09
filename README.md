# Voice-OpenClaw

A Discord voice bot that captures voice channel audio, transcribes it, queries an OpenClaw AI agent, and plays back the synthesized response.

## Architecture

```
Discord Voice -> Opus->PCM->WAV -> STT -> text -> OpenClaw -> reply text -> TTS -> WAV -> Discord Audio Player
```

Four Docker services:

| Service | Description | Port |
|---------|-------------|------|
| **openclaw** | AI agent backend (Claude Sonnet 4.6) | 18789, 18791 |
| **stt** | Speech-to-text (faster-whisper, Japanese) | 8000 |
| **tts** | Text-to-speech (edge-tts, Microsoft Neural) | 8001 |
| **discord-voice-bot** | Discord voice bot (Node.js) | - |

## Setup

### 1. Environment Variables

```bash
cp .env.template .env
```

Edit `.env`:

```
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_guild_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
OPENCLAW_TOKEN=your_openclaw_gateway_token
```

### 2. OpenClaw Configuration

```bash
cp openclaw/openclaw.json.template openclaw/openclaw.json
```

Set `gateway.auth.token` in `openclaw.json` to match the `OPENCLAW_TOKEN` in `.env`.

On first startup, visit `http://localhost:18791` to complete device pairing and Anthropic token authentication.

### 3. Start

```bash
docker compose up -d --build
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
docker compose build discord-voice-bot
docker compose up -d discord-voice-bot
```

## Features

- Real-time voice recognition from Discord voice channels (Japanese)
- Automatic query to OpenClaw AI agent
- Voice response via Microsoft Neural Japanese TTS
- Conversation history posted to Discord text channel
- Auto-reconnect on Discord/OpenClaw disconnection
- Debug mode (`DEBUG_AUDIO=true`) saves WAV files for inspection

## Limitations

- Processes one utterance at a time (busy lock)
- Max 6 seconds per utterance
- Audio shorter than 0.6 seconds is discarded
- Replies longer than 220 characters are truncated for TTS
- TTS (edge-tts) requires internet connectivity
