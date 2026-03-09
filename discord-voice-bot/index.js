import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  EndBehaviorType,
  VoiceConnectionStatus
} from "@discordjs/voice";
import prism from "prism-media";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import WebSocket from "ws";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;

const OPENCLAW_BASE_URL = process.env.OPENCLAW_BASE_URL || "http://openclaw:18789";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "";
const OPENCLAW_SESSION = process.env.OPENCLAW_SESSION || "voice-bot";
const STT_URL = process.env.STT_URL;
const TTS_URL = process.env.TTS_URL;
const AUTO_JOIN = (process.env.AUTO_JOIN || "true") === "true";
const DEBUG_AUDIO = (process.env.DEBUG_AUDIO || "false") === "true";

if (!TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID || !STT_URL || !TTS_URL) {
  console.error("Missing env vars. Check .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const TEXT_CHANNEL_ID = process.env.DISCORD_TEXT_CHANNEL_ID || VOICE_CHANNEL_ID;

const player = createAudioPlayer();
let busy = false;
let textChannel = null;

// --- OpenClaw WebSocketクライアント ---

class OpenClawClient {
  constructor(baseUrl, token, sessionKey) {
    this.baseUrl = baseUrl.replace(/^http/, "ws");
    this.token = token;
    this.sessionKey = sessionKey;
    this.ws = null;
    this.pending = new Map();
    this._eventBuffer = new Map();
    this.connected = false;
    this._connectPromise = null;
  }

  // WebSocket接続 + チャレンジ認証
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      const origin = this.baseUrl.replace(/^ws/, "http");
      this.ws = new WebSocket(`${this.baseUrl}/ws`, { origin });

      this.ws.on("open", () => console.log("[OpenClaw] WebSocket connected"));

      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.type === "event" && msg.event === "connect.challenge") {
          // チャレンジ受信 → connect リクエスト送信
          this._request("connect", {
            minProtocol: 3, maxProtocol: 3,
            client: {
              id: "gateway-client", version: "1.0",
              platform: "node", mode: "webchat",
              instanceId: randomUUID()
            },
            role: "operator",
            scopes: ["operator.admin"],
            auth: { token: this.token },
            caps: []
          }).then(() => {
            console.log("[OpenClaw] Authenticated");
            this.connected = true;
            resolve();
          }).catch(reject);
          return;
        }

        // リクエスト/レスポンス処理
        if (msg.type === "res") {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.ok ? p.resolve(msg.payload) : p.reject(new Error(msg.payload?.message || "OpenClaw request failed"));
          }
          return;
        }

        // その他のイベントをログ
        if (msg.type === "event" && msg.event !== "agent" && msg.event !== "connect.challenge" && msg.event !== "tick") {
          console.log("[OpenClaw] event:", msg.event, JSON.stringify(msg).slice(0, 200));
        }

        // agentイベント: チャット応答のテキストを収集
        if (msg.type === "event" && msg.event === "agent") {
          if (DEBUG_AUDIO) {
            console.log("[OpenClaw] agent event:", JSON.stringify(msg).slice(0, 300));
          }
          const { runId, stream, data: evData } = msg.payload || msg;
          let p = this.pending.get(runId);

          // pendingにまだ登録されていない場合はバッファに溜める
          if (!p) {
            if (!this._eventBuffer.has(runId)) {
              this._eventBuffer.set(runId, { chunks: [], finished: false });
            }
            const buf = this._eventBuffer.get(runId);
            if (stream === "text" || stream === "assistant") {
              buf.chunks.push(evData.delta || evData.text || "");
            } else if (stream === "lifecycle" && evData.phase === "end") {
              buf.finished = true;
            } else if (stream === "lifecycle" && evData.phase === "error") {
              buf.error = evData.error || "OpenClaw agent error";
              buf.finished = true;
            }
            return;
          }

          if (stream === "text" || stream === "assistant") {
            p.chunks.push(evData.delta || evData.text || "");
          } else if (stream === "lifecycle") {
            if (evData.phase === "end") {
              this.pending.delete(runId);
              p.resolve(p.chunks.join(""));
            } else if (evData.phase === "error") {
              this.pending.delete(runId);
              p.reject(new Error(evData.error || "OpenClaw agent error"));
            }
          }
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[OpenClaw] WebSocket closed: ${code} ${reason.toString()}`);
        this.connected = false;
        this._connectPromise = null;
        // 保留中のリクエストをすべて拒否
        for (const [, p] of this.pending) {
          p.reject(new Error("OpenClaw connection closed"));
        }
        this.pending.clear();
        // 自動再接続
        console.log("[OpenClaw] Reconnecting in 5s...");
        setTimeout(() => this.connect().catch(e => console.error("[OpenClaw] Reconnect failed:", e.message)), 5000);
      });

      this.ws.on("error", (err) => {
        console.error("[OpenClaw] WebSocket error:", err.message);
      });
    });
    return this._connectPromise;
  }

  // 低レベルリクエスト送信
  _request(method, params) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  // チャットメッセージ送信 → 応答テキスト全文を返す
  async chat(message) {
    if (!this.connected) await this.connect();

    // agentイベント収集用のPromiseを先に作る
    return new Promise((resolve, reject) => {
      const idempotencyKey = randomUUID();

      // chat.sendのレスポンスでrunIdが返るので、それをpendingに登録
      this._request("chat.send", {
        sessionKey: this.sessionKey,
        message,
        deliver: false,
        idempotencyKey
      }).then((result) => {
        const runId = result.runId;
        if (!runId) { reject(new Error("OpenClaw: no runId returned")); return; }

        // 既にバッファされたイベントがあれば引き継ぐ
        const buffered = this._eventBuffer.get(runId);
        this._eventBuffer.delete(runId);
        const chunks = buffered ? buffered.chunks : [];
        const finished = buffered ? buffered.finished : false;

        if (finished) {
          resolve(chunks.join(""));
          return;
        }

        this.pending.set(runId, { resolve, reject, chunks });

        // タイムアウト 60秒
        setTimeout(() => {
          if (this.pending.has(runId)) {
            const p = this.pending.get(runId);
            this.pending.delete(runId);
            if (p.chunks.length > 0) {
              resolve(p.chunks.join(""));
            } else {
              reject(new Error("OpenClaw: response timeout"));
            }
          }
        }, 60000);
      }).catch(reject);
    });
  }
}

const openclawClient = new OpenClawClient(OPENCLAW_BASE_URL, OPENCLAW_TOKEN, OPENCLAW_SESSION);

async function openclawChat(text) {
  return await openclawClient.chat(text);
}

async function sttFromWavBuffer(wavBuffer) {
  const form = new FormData();
  form.append("file", wavBuffer, { filename: "audio.wav", contentType: "audio/wav" });

  const res = await fetch(STT_URL, { method: "POST", body: form });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`STT error: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.text || "";
}

async function ttsToWavBuffer(text) {
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TTS error: ${res.status} ${t.slice(0, 200)}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function connectToVoice(guild) {
  const channel = guild.channels.cache.get(VOICE_CHANNEL_ID);
  if (!channel) throw new Error("Voice channel not found");
  const connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  connection.subscribe(player);
  return connection;
}

function bufferToWav(pcmBuffer, sampleRate = 48000, channels = 1) {
  // 超ミニマムWAVヘッダ付与（16-bit PCM）
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // PCM fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function setupReceiver(connection) {
  const receiver = connection.receiver;
  const botUserId = client.user.id;

  if (DEBUG_AUDIO) {
    console.log("[DEBUG_AUDIO] setupReceiver called, listening for speaking events...");
  }

  receiver.speaking.on("start", async (userId) => {
    // ボット自身の音声を無視
    if (userId === botUserId) return;
    if (busy) return; // 暴走防止：同時処理しない
    busy = true;

    // busyスタック防止：30秒後に強制解放
    const busyTimeout = setTimeout(() => {
      if (busy) {
        console.warn("[Pipeline] busy timeout, forcing release");
        busy = false;
      }
    }, 30000);

    try {
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 800 // 0.8秒無音で終了
        }
      });

      opusStream.on("error", (e) => {
        console.error("Opus stream error:", e.message);
      });

      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
      const pcmChunks = [];
      const pcmStream = opusStream.pipe(decoder);

      // 最大収録 6秒（長すぎると遅延が悪化）
      const timeout = setTimeout(() => {
        try { opusStream.destroy(); } catch {}
      }, 6000);

      pcmStream.on("data", (chunk) => pcmChunks.push(chunk));

      pcmStream.on("end", async () => {
        clearTimeout(timeout);

        const pcm = Buffer.concat(pcmChunks);
        if (pcm.length < 48000 * 2 * 1 * 0.6) { // 0.6秒未満は捨てる
          clearTimeout(busyTimeout);
          busy = false;
          return;
        }

        const wav = bufferToWav(pcm);

        // デバッグ: 音声受信情報をログ出力 + WAVファイル保存（直近10件のみ保持）
        if (DEBUG_AUDIO) {
          const durationSec = (pcm.length / (48000 * 2 * 1)).toFixed(2);
          console.log(`[DEBUG_AUDIO] userId=${userId} pcmBytes=${pcm.length} duration=${durationSec}s`);
          try {
            const debugDir = "/app/debug";
            fs.mkdirSync(debugDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            fs.writeFileSync(`${debugDir}/${timestamp}_${userId}.wav`, wav);
            console.log(`[DEBUG_AUDIO] Saved ${debugDir}/${timestamp}_${userId}.wav`);

            // 古いファイルを削除（直近10件のみ保持）
            const files = fs.readdirSync(debugDir)
              .filter(f => f.endsWith(".wav"))
              .sort();
            for (const old of files.slice(0, -10)) {
              fs.unlinkSync(`${debugDir}/${old}`);
            }
          } catch (e) {
            console.error("[DEBUG_AUDIO] WAV save failed:", e.message);
          }
        }

        try {
          const text = (await sttFromWavBuffer(wav)).trim();
          if (!text) {
            clearTimeout(busyTimeout);
            busy = false;
            return;
          }

          // ここで「起動ワード」必須にすると誤作動が減る（推奨）
          // 例：先頭が「クロウ」or「OpenClaw」のときだけ通す
          // if (!/^openclaw|クロウ/i.test(text)) { busy = false; return; }

          const reply = await openclawChat(text);
          console.log(`[Pipeline] STT="${text}" → OpenClaw="${reply.slice(0, 100)}"`);

          // テキストチャンネルに履歴を残す
          if (textChannel) {
            try {
              await textChannel.send(`🎤 **${text}**\n💬 ${reply}`);
            } catch (e) {
              console.error("[Pipeline] Text message send failed:", e.message);
            }
          }

          // 長文を音声化すると地獄なので短く切る（重要）
          const spoken = reply.length > 220 ? reply.slice(0, 220) + "。続きはテキストで。" : reply;

          const ttsWav = await ttsToWavBuffer(spoken);
          console.log(`[Pipeline] TTS received ${ttsWav.length} bytes`);

          const resource = createAudioResource(Readable.from(ttsWav));
          player.play(resource);
          console.log("[Pipeline] Playing audio...");

          player.once(AudioPlayerStatus.Idle, () => {
            console.log("[Pipeline] Playback finished");
            clearTimeout(busyTimeout);
            busy = false;
          });
        } catch (pipelineErr) {
          console.error("Pipeline error (STT/OpenClaw/TTS):", pipelineErr.message);
          clearTimeout(busyTimeout);
          busy = false;
        }
      });

      pcmStream.on("error", (e) => {
        clearTimeout(timeout);
        clearTimeout(busyTimeout);
        busy = false;
        console.error("PCM error", e);
      });
    } catch (e) {
      clearTimeout(busyTimeout);
      busy = false;
      console.error("Receiver error", e);
    }
  });
}

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  const fullGuild = await guild.fetch();

  // テキストメッセージ送信用チャンネル取得
  try {
    textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
    console.log(`Text channel: #${textChannel.name} (${TEXT_CHANNEL_ID})`);
  } catch (e) {
    console.warn("Could not fetch text channel:", e.message);
  }

  if (!AUTO_JOIN) {
    console.log("AUTO_JOIN=false. Not joining voice.");
    return;
  }

  async function startVoice() {
    const connection = connectToVoice(fullGuild);
    console.log("Joined voice channel.");

    connection.on("error", (err) => {
      console.error("[Connection] error:", err);
    });

    // 切断時に自動再接続
    connection.on("stateChange", (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        console.log("[Connection] Disconnected, reconnecting in 3s...");
        busy = false;
        setTimeout(() => {
          try {
            connection.destroy();
          } catch {}
          startVoice();
        }, 3000);
      }
    });

    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      await new Promise((resolve) => {
        connection.once(VoiceConnectionStatus.Ready, resolve);
      });
    }
    console.log("Voice connection is Ready.");

    await setupReceiver(connection);
  }

  await startVoice();
});

client.login(TOKEN);