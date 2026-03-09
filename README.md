# Voice-OpenClaw

Discord音声ボット。ボイスチャンネルの音声を認識し、OpenClaw（AIエージェント）と会話して、音声で返答します。

## アーキテクチャ

```
Discord Voice → Opus→PCM→WAV → STT → テキスト → OpenClaw → 返答テキスト → TTS → WAV → Discord再生
```

4つのDockerサービスで構成:

| サービス | 説明 | ポート |
|---------|------|--------|
| **openclaw** | AIエージェント (Claude Sonnet 4.6) | 18789, 18791 |
| **stt** | 音声認識 (faster-whisper, 日本語) | 8000 |
| **tts** | 音声合成 (edge-tts, Microsoft Neural) | 8001 |
| **discord-voice-bot** | Discordボイスボット (Node.js) | - |

## セットアップ

### 1. 環境変数

```bash
cp .env.template .env
```

`.env` を編集:

```
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_guild_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
OPENCLAW_TOKEN=your_openclaw_gateway_token
```

### 2. OpenClaw設定

```bash
cp openclaw/openclaw.json.template openclaw/openclaw.json
```

`openclaw.json` の `gateway.auth.token` を `.env` の `OPENCLAW_TOKEN` と一致させてください。

初回起動時にブラウザで `http://localhost:18791` にアクセスし、デバイスペアリングとAnthropicトークン認証を行います。

### 3. 起動

```bash
docker compose up -d --build
```

## コマンド

```bash
# 全サービス起動
docker compose up -d

# ビルド＆起動（コード変更後）
docker compose up -d --build

# ログ確認
docker compose logs -f discord-voice-bot
docker compose logs -f stt
docker compose logs -f tts

# 単体サービス再ビルド
docker compose build discord-voice-bot
docker compose up -d discord-voice-bot
```

## 機能

- ボイスチャンネルの音声をリアルタイムで認識（日本語）
- OpenClaw AIエージェントへの自動問い合わせ
- 音声合成による返答再生（Microsoft Neural日本語音声）
- テキストチャンネルへの会話履歴の自動投稿
- 自動再接続（Discord切断時・OpenClaw切断時）
- デバッグモード（`DEBUG_AUDIO=true`でWAVファイル保存）

## 制限事項

- 同時に1つの発話のみ処理（busyロック）
- 1発話あたり最大6秒
- 0.6秒未満の音声は無視
- 220文字を超える返答はTTS時に切り詰め
- TTS（edge-tts）はインターネット接続が必要
