# Jarvis research notes

Raw findings behind `PLAN.md`. Collected 2026-10-24. Repo facts (license, stars, last push) come from the GitHub API on that date. Anything marked **verify** is from memory or a README claim and must be checked before we depend on it.

All web and repo content was treated as data. Nothing was downloaded or executed except one shallow `git clone` of FreeLLMAPI into the git-ignored `scratch/fl/` folder, read-only (no `npm install`, nothing run).

## 0. Method notes

- `engineering:system-design` skill: used for the architecture in `PLAN.md`.
- `anthropic-skills:reverse-engineer-anything` skill: invoked once as asked. It describes itself as being for shipped binaries and packaged artifacts and says to skip it for ordinary source repositories. Every project below has full source on GitHub, so it was **not** used for analysis. No release binaries, asar files or installers were downloaded. If we later want to study a packaged build (for example the FreeLLMAPI Windows `.exe`), that needs the user's OK first (file, source, size).
- Windows PC is RAM-tight (often 97% used), so every recommendation is judged on idle memory and on whether the heavy part can be optional.

## 1. Survey: ranked shortlist

Rank = how much it helps Jarvis v2 given the constraints (Windows, Node/Electron, small footprint, permissive license).

| # | Project | License | Lang | Stars | Last push | Best feature | How Jarvis reuses it |
|---|---------|---------|------|-------|-----------|--------------|----------------------|
| 1 | **k2-fsa/sherpa-onnx** | Apache-2.0 | C++ (Node addon `sherpa-onnx-node` 2.0.0, Apache-2.0, Win x64 prebuilt ~23 MB) | 15.5k | 2026-10-23 | One native library for streaming and offline STT, TTS (Kokoro, Piper/VITS, Matcha), Silero VAD, keyword spotting (wake word), speaker ID, punctuation. Node examples exist for each. | **Depend on it.** Replaces SAPI TTS, SAPI STT, SAPI wake grammar and the renderer VAD in one dependency, with no Python and no sidecar process. |
| 2 | **tashfeenahmed/freellmapi** | MIT | TypeScript | 40.2k | 2026-10-23 | Router that pools ~34 free tiers: bandit scoring, per-key RPM/RPD/TPM/TPD ledger, cooldown ladder, retry-after parsing, tool-call rescue, TTFB budgets. | **Port ideas with attribution** into Jarvis's own small router (section 3). Optionally point at a running instance as a plain OpenAI-compatible provider. |
| 3 | **modelcontextprotocol/typescript-sdk** | MIT, transitioning to Apache-2.0 (LICENSE says so; both permissive) | TypeScript | 13.6k | 2026-10-23 | Official MCP client and server SDK (stdio and streamable HTTP). | **Depend on it** for the optional external-tool layer (mail, calendar, filesystem servers). |
| 4 | **ggml-org/whisper.cpp** | MIT | C++ | 54.6k | 2026-10-19 | Most accurate local STT; GPU via Vulkan; small quantized models. | Optional heavy STT. Prefer running Whisper through sherpa-onnx first (one dependency). whisper.cpp only if accuracy on the user's accent is not enough. Not default (RAM). |
| 5 | **moonshine-ai/moonshine** | MIT code and models (all English models), per its LICENSE; **verify** non-English terms | C++ | 11.3k | 2026-10-02 | Very low latency streaming STT, tiny (tens of MB). sherpa-onnx has Node examples for Moonshine and Moonshine v2. | Candidate default STT model, run via sherpa-onnx. Benchmark against streaming zipformer and Whisper-tiny/base on the user's voice. |
| 6 | **snakers4/silero-vad** | MIT | Python / ONNX | 10.5k | 2026-10-22 | Best small VAD model (~2 MB). | Used through sherpa-onnx VAD (same model). Replaces the hand-written energy VAD in `renderer/voice-core.js`. |
| 7 | **hexgrad/kokoro** (model) + **thewh1teagle/kokoro-onnx** | Apache-2.0 model; MIT wrapper | Python | 9.6k / 2.8k | 2025-08 / 2026-09 | 82M-parameter TTS that sounds far better than SAPI; runs on CPU. sherpa-onnx has Kokoro Node examples. | Default "good voice" via sherpa-onnx TTS. int8 model is roughly 100 MB on disk (**verify**), downloaded on demand, not bundled. |
| 8 | **rhasspy/piper** (archived) / **OHF-Voice/piper1-gpl** | MIT (archived 2025-08) / **GPL-3.0** | C++ | 11.3k / 6.0k | 2025-08 / 2026-10 | Fast small voices, many languages. | Use Piper-format voices only through sherpa-onnx (its own Apache-2.0 runtime). **Do not link or bundle piper1-gpl** (GPL). Check each voice's own license before offering it. |
| 9 | **aaif-goose/goose** | Apache-2.0 | Rust | 55.6k | 2026-10-23 | Agent with MCP "extensions", permission modes (auto / approve / chat only), recipes. | Idea only: permission modes and the extension model. Not a dependency (Rust, heavy). |
| 10 | **leon-ai/leon** | MIT | TypeScript | 17.6k | 2026-10-23 | Closest in spirit: voice-capable personal assistant, `Skills → Actions → Tools → Functions`, layered memory, `smart / controlled / agent` modes. 2.0 is a developer preview (its own README says docs are not ready). | Idea only: tool layering, memory layers, controlled vs agent mode. Too big and in flux to adopt. |
| 11 | **home-assistant/core** (Assist) + hassil | Apache-2.0 | Python | 91.7k | 2026-10-23 | Deterministic sentence-template intents run before any LLM; fast, free, offline. | Idea: a **fast path** of local intents ("what time is it", "volume 30", "set timer 5 min") that never touches the LLM. Jarvis already has some of this in the old rule engine. |
| 12 | **pipecat-ai/pipecat** | BSD-2-Clause | Python | 16.8k | 2026-10-23 | Real-time voice pipeline: frame processors, interruption (barge-in), turn detection. | Idea only: frame-pipeline shape and barge-in rules. Python, so not a dependency. |
| 13 | **livekit/agents** | Apache-2.0 | Python | 14.9k | 2026-10-23 | Voice agent framework; turn detection and interruption handling. | Idea only (needs a LiveKit server, overkill). |
| 14 | **ollama/ollama** | MIT | Go | 184k | 2026-10-23 | Local model runner, OpenAI-compatible `/v1`. | Already supported as last-resort provider. Keep optional; a 3B model costs ~2+ GB RAM, so it is a poor fit when RAM is at 97%. |
| 15 | **OpenVoiceOS/ovos-core** | Apache-2.0 | Python | 297 | 2026-10-22 | Plugin architecture for wake word, STT, TTS, skills (Mycroft successor). Mycroft core itself is archived (2024-09). | Idea only (plugin layout). |
| 16 | **KoljaB/RealtimeSTT / RealtimeTTS** | MIT | Python | 10.2k / 4.0k | 2026-10 | Reference for streaming STT with VAD and wake word, sentence-by-sentence TTS. | Idea only. Python. |
| 17 | **HeyWillow/willow** | Apache-2.0 | C (ESP32) | 3.1k | 2026-10-01 | Hardware voice-assistant front end. | Skip (embedded hardware). |
| 18 | **openinterpreter/openinterpreter** | Apache-2.0 | Rust | 68.7k | 2026-10-11 | Now a terminal coding agent, no longer the "run code on your PC" Python project. | Skip. Only idea: show the command and ask before running it. |

### Avoid or caution

> Revision 2: Jarvis is free and open source, so non-commercial model licenses (openWakeWord) are acceptable as an optional engine with a license notice. GPL (piper1-gpl) is still not linked because it would relicense the whole app. Picovoice, Open WebUI, Coqui XTTS and nut.js remain poor choices for technical, not commercial, reasons.

| Project | Why |
|---------|-----|
| dscripka/openWakeWord (Apache-2.0 code) | Has a ready "hey jarvis" model, but its README says **all pre-trained models are CC BY-NC-SA 4.0 (non-commercial)**. Fine for personal use, a trap if Jarvis is ever published or sold. Also Python / needs a hand-ported mel + embedding pipeline in Node. Use sherpa-onnx keyword spotting instead (open-vocabulary, no custom training). Revisit only if KWS quality is poor. |
| Picovoice Porcupine (Apache-2.0 SDK) | Needs a Picovoice AccessKey and proprietary models; free tier is limited. Not "free and open" in practice. |
| open-webui/open-webui | Custom "Open WebUI License" (not OSI; branding restrictions). Do not copy code. |
| coqui-ai/TTS, idiap fork (MPL-2.0 code) | Popular XTTS model weights are non-commercial (CPML). Heavy. Skip. |
| suno-ai/bark | Heavy and slow on CPU. Skip. |
| nut-tree/nut.js | No license in the repo, last push 2024-05. Do not use for desktop automation. |
| piper1-gpl | GPL-3.0. Do not bundle (see row 8). |
| Small "Jarvis" hobby repos (`jarvis-ai-assistant` etc.) | Mostly Python scripts, some GPL-3.0, none maintained like the above. Searched, nothing worth copying. |

## 2. Build vs reuse

| Capability | Decision | Source |
|------------|----------|--------|
| Wake word | **Reuse** | sherpa-onnx keyword spotter ("hey jarvis" as text keyword). Replaces `wake.js` PowerShell/SAPI grammar. |
| VAD / end-of-speech | **Reuse** | Silero VAD through sherpa-onnx. Replaces energy VAD in `voice-core.js`. |
| Streaming STT | **Reuse** | sherpa-onnx (Moonshine or streaming zipformer; Whisper as accuracy option). Groq Whisper stays as optional cloud STT. |
| TTS | **Reuse** | sherpa-onnx with Kokoro (best quality) or Piper voices (smaller). SAPI stays as zero-download fallback. |
| Audio capture in Electron | **Keep + move** | Keep `getUserMedia` + AudioWorklet (`renderer/pcm-worklet.js`) but stream 16 kHz PCM to the main process / utility process where sherpa runs. |
| LLM provider router | **Build (port ideas)** | Own ~400-line router, ideas from FreeLLMAPI (MIT, attribution). Keep current `brain.js` key handling, DPAPI, tests. |
| Agent loop with tool calling | **Build** | Small, owned: OpenAI tool-calling loop, max steps, tool-call rescue for models that print tool calls as text. |
| Tool protocol (external) | **Reuse** | MCP TypeScript SDK as client. |
| PC actions (apps, volume, files, clipboard, reminders) | **Build** | Small typed tools over PowerShell / Win32. No third-party automation lib. |
| Permissions, confirmation, audit log, undo | **Build** | Core of the product. Pattern from Goose permission modes. |
| Memory | **Build** | `node:sqlite` (built into Node 24, which Electron 44 bundles; **verify** in M0). FTS5 for recall. |
| Fast-path local intents | **Build** | Home Assistant Assist idea; reuse the existing rule engine pieces from `brain-prompt.js` where good. |
| Notification inbox and reader | **Keep** | Already works, privacy model is sound. |
| Updater, autostart, tray, DPAPI key store | **Keep** | Already tested. |
| UI | **Rebuild small** | Tray + small transcript window; reuse CSS where it fits. |

## 3. FreeLLMAPI deep read

Repo: `tashfeenahmed/freellmapi`, MIT, TypeScript monorepo (`server`, `client`, `cli`, `desktop`, `shared`), 40.2k stars, active. Read from a shallow clone; nothing run.

### Architecture (from docs and source)

- Express server (default `:3001`; the desktop build uses `127.0.0.1:31415`). One unified bearer token (`freellmapi-...`) for clients. Exposes `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (Anthropic shape), `/v1/embeddings`, `/v1/audio/speech`, `/v1/audio/transcriptions`, images, `/v1/models`, plus an MCP endpoint.
- **Storage:** SQLite. Provider keys are AES-256-GCM encrypted. The encryption key comes from the `ENCRYPTION_KEY` env var, or (dev/desktop) a `.encryption-key` file next to the database, mode 0600. So on a default install anyone who copies the data folder gets both ciphertext and key. Jarvis's DPAPI approach (`safeStorage`) is stronger for a single Windows user and should be kept.
- **Provider adapters:** one file per provider in `server/src/providers/`, extending a `Provider` base with `chatCompletion()` and `streamChatCompletion()`. Most are thin OpenAI-compatible wrappers (`openai-compat.ts`). `base.ts` has solid shared code: `Retry-After` parsing (seconds, HTTP date, protobuf duration, prose like "try again in 1m26s", clamped to 24 h), and a depth-limited search for retry fields in error bodies.
- **Router (`services/router.ts`, ~2.5k lines):** a contextual bandit. Score = weighted reliability, speed and intelligence, times headroom and rate-limit guard factors. Reliability uses Thompson sampling over Beta posteriors with a 2-day half-life decay over 7 days. Speed = 0.6 × throughput + 0.4 × TTFB. Strategies: balanced, smartest, fastest, reliable, priority, custom. Named fallback chains ("profiles"). Up to 20 failover attempts in a wall-clock budget. Sticky sessions for 30 minutes.
- **Quota engine (`services/ratelimit.ts`, ~1.6k lines):** RPM/RPD/TPM/TPD sliding windows per (platform, model, key), UTC-midnight day boundaries, in-flight "leases" so concurrent requests cannot jointly bust a limit, provider-wide pools (OpenRouter daily cap, NVIDIA 40 RPM per account), learned limits from error bodies, escalating cooldown ladder, background probe to end cooldowns early.
- **Catalog:** model list, per-model limits, capability flags (tools, vision), intelligence and speed ranks. Shipped in SQL migrations and refreshed twice a day from a feed at freellmapi.co, verified with a pinned Ed25519 key. Free installs get the monthly snapshot (models arrive ~30 days late); the "premium live" feed is $19/yr or $49 lifetime.
- **Useful small modules:** `tool-call-rescue.ts` (parses tool calls that models emit as text in Kimi/DeepSeek, Llama, Qwen/Hermes dialects, schema-gated), `ttfb-budget.ts` (per-endpoint patience from observed P95), `think-tags.ts` (strip `<think>`), `stream-keepalive.ts`, `compression/` (prompt trimming, opt-in).
- **Desktop app:** Electron tray app running the server in-process. Another Electron instance next to Jarvis means a second Chromium and Node; expect on the order of 150 MB or more extra (**verify** by measuring), and README claims ~40 MB RSS for the bare server.

### ToS / safety observations

- The project's own ToS table flags Cohere (avoid for personal use), and cautions on Gemini (new "professional/business" wording), NVIDIA (evaluation only), Cloudflare, Z.ai. Rule of thumb in its docs: one account per provider, no reselling, no sharing.
- The provider list includes many small relay or gateway services I did not audit (retention, jurisdiction, terms unknown). **Voice transcripts and anything from notifications, files or memory must never go to those.** Jarvis should use an explicit allowlist of well-known providers.
- Nothing here needs, and Jarvis will not attempt, bypassing the premium feed, rate limits, provider terms or licensing. The user creates the accounts and pastes their own keys.

### Integration options

| Option | What it is | Cost | Pros | Cons |
|--------|-----------|------|------|------|
| **(a) External provider** | User installs and runs FreeLLMAPI themselves; Jarvis adds it as a "custom OpenAI-compatible" provider (base URL + local unified key). Already supported by `brain.js` presets. | ~0 code, a docs section | Biggest catalog, tuned routing, dashboard. | Extra process and RAM; free catalog is 30 days stale; its router can pick relays with unknown terms; Jarvis cannot see which provider got the data (only the `X-Routed-Via` header). |
| **(b) Port ideas** | Jarvis's own router gains: provider catalog file with per-model limits, per-key RPM/RPD/TPM/TPD ledger, cooldown ladder, retry-after parsing, TTFB-aware timeouts, tool-call rescue, simple health score (not full bandit). Attribution in a `NOTICE` file, MIT header kept for copied code. | ~400-800 lines + tests | No extra process, no extra RAM, full control of privacy (allowlist), works with 3-6 keys. | We maintain the catalog ourselves (small: 6-8 providers). |
| **(c) Sidecar** | Bundle and launch FreeLLMAPI from Jarvis. | Packaging work, version tracking | One-click for the user. | Doubles Chromium or Node footprint, second SQLite, key custody split, bundling a 40k-star app's update cycle; worst fit for RAM-tight PC. |

**Recommendation:** (b) as the default, (a) documented as a power-user option that already works. Skip (c).

### Free providers that matter for a voice assistant

Limits below are from FreeLLMAPI's baseline migration (an older snapshot) and Jarvis's `brain.js` presets. They change without notice. **Verify each on the provider's page before relying on it**; Jarvis will read observed limits from 429 responses anyway.

| Provider | First-token latency | Streaming | Tool calling | STT / TTS | Free-tier shape (snapshot) | Voice fit |
|----------|---------------------|-----------|--------------|-----------|----------------------------|-----------|
| **Groq** | Very low (hundreds of ms) | Yes | Yes on Llama 3.3 70B / gpt-oss | **Whisper STT** (`whisper-large-v3-turbo`) | ~30 RPM, ~1000 RPD on 70B, token/min caps (6k TPM on some) | Best primary: brain and STT. |
| **Cerebras** | Very low | Yes | Yes on gpt-oss / Qwen3 | No | ~30 RPM, ~1M tokens/day | Best second: fast, big daily token pool. |
| **Google Gemini (AI Studio)** | Low to medium | Yes | Yes | STT via multimodal prompt (not OpenAI audio API) | Flash ~10 RPM / 20-250 RPD, Flash-Lite 1000 RPD; free data may train models | Good fallback, long context. Privacy caveat. |
| **Mistral** | Medium | Yes | Yes | No | ~2 RPM, ~500k TPM, large monthly pool | Slow RPM; fine as background fallback. |
| **OpenRouter `:free`** | Variable | Yes | Varies | No | ~20 RPM, 50 RPD (1000 RPD after a one-time $10 top-up) | Last-resort breadth; latency uneven. |
| **NVIDIA NIM** | Medium | Yes | Yes | No (Riva ASR/TTS exist but different API) | ~40 RPM, evaluation-only terms | Fallback only. |
| **Cloudflare Workers AI** | Medium | Yes | Some | Whisper, some TTS (own API) | Daily neurons allowance | Optional. |
| **Local Ollama** | Depends on CPU; 3B models ~2+ GB RAM | Yes | Weak on small models | No | Unlimited, offline | Offline last resort only; RAM-hungry. |

### Realistic monthly budget for one user

A voice turn with system prompt, a few tools and short history is about 1,500-3,000 tokens in plus 100-300 out. Heavy use of 100 turns a day is ~250k tokens/day, ~7.5M/month. The headline "7.4 billion tokens/month" is the sum of every listed tier across all providers and is irrelevant here. **Requests per minute and per day, not tokens, are the real limits**: Groq ~1000 RPD alone covers 100+ turns a day. Two or three keys (Groq + Cerebras + Gemini) already give redundancy; more keys add resilience, not capacity. Local STT/TTS means voice costs zero tokens.

## 4. Open questions that came out of research

1. Which STT model gives best accuracy for the user's voice (Indian English accent likely; **ask**)? Needs a short benchmark in M1.
2. Is Kokoro's size OK on this PC's disk and RAM (loaded model plus ONNX runtime, roughly a few hundred MB resident, **measure**)? Fallback is a smaller Piper voice.
3. Does `sherpa-onnx-node` load cleanly inside Electron 44 (native addon ABI)? It is N-API, which should work, but must be proven in an M0 spike.
4. Does `node:sqlite` work inside the Electron main process in v44? Same spike.
