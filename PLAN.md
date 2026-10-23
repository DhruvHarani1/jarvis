# Jarvis v2: plan

Status: **draft for approval**. Nothing in this plan has been built yet. Evidence and sources are in `RESEARCH.md`.

## 0. Revision 2 (after Dhruv's answers, 2026-10-24)

Decisions from the user, which override anything below that disagrees:

1. **Open source, free, non-commercial.** Jarvis is a free open-source project. So non-commercial model licenses (for example openWakeWord's CC BY-NC-SA "hey jarvis" model) are acceptable as an *optional* wake-word engine, with the license shown in `NOTICE`. GPL code (piper1-gpl) is still not linked, because a GPL dependency would force the whole app to GPL; Piper-format voices run through sherpa-onnx anyway, so nothing is lost. Default stays sherpa-onnx keyword spotting (no license issue).
2. **Control the whole PC, "Iron Man experience".** Scope grows from "a few Windows tools" to a full **connector layer**: WhatsApp, Spotify, Mail, Calendar, Teams, browser, any desktop app. The security tiers stay (an assistant that can act on everything must be able to be stopped), but Tier 3 is no longer "never": a **Power mode** (arbitrary PowerShell and UI automation) exists, off by default, every call confirmed with the exact command shown. See section 5.5.
3. **Only a Groq key so far.** The plan works with one key. M4 includes a "get more free keys" guide (Cerebras, Gemini, OpenRouter, Mistral). The user signs up and pastes keys; Jarvis never does.
4. **FreeLLMAPI "7.4B free tokens" checked.** True only as a sum of every listed free tier across ~34 providers, each of which needs *your own account and key*. FreeLLMAPI creates no tokens; with zero provider keys it gives you nothing. With one Groq key it routes to Groq only. Details in `RESEARCH.md` section 3 and section 6 below.
5. **Start now.** M0 started (see section 12, M0 results).

## 1. Summary

Jarvis today is a good voice shell with no hands: it hears you, thinks with free LLM keys, speaks with robotic Windows voices, and reads notifications aloud. v2 keeps that shell and adds what is missing:

1. **Better voice**, fully local by default: wake word, VAD, STT and neural TTS from one Apache-2.0 library (`sherpa-onnx`), no Python.
2. **Hands**: a permissioned tool layer so Jarvis can open apps, set volume, find files, manage reminders and clipboard, with confirmation for risky things, an audit log and undo where possible. MCP for optional extras (mail, calendar).
3. **Memory**: short-term conversation and long-term facts in local SQLite.
4. **A small free-LLM router** built from the good ideas in FreeLLMAPI (MIT, with attribution), not the whole app.
5. **Release**: signed-off installer, auto-update, resource budget that respects a PC sitting at 97% RAM.

Recommendation on the question that started this: **do not run FreeLLMAPI as part of Jarvis.** Port its ideas (option b). Running it yourself and pointing Jarvis at it keeps working as an advanced option (option a). Reasons in section 6.

## 2. Goals and non-goals

### Goals

- Voice-first on Windows 10/11. Say "Hey Jarvis", ask or command, hear a natural voice answer, first spoken word in about 1.5 s on a normal turn (target, to be measured).
- Useful actions on the PC, safe by default.
- Works with **zero paid services**. Works offline for voice, timers, reminders, app control and notifications; only the LLM needs internet (or Ollama).
- Private by default: mic only on when the indicator says so; nothing leaves the PC unless the user picked a cloud provider; keys encrypted with DPAPI.
- Small: low idle memory, heavy parts lazy-loaded and optional.
- One developer plus Claude can maintain it: plain JavaScript, few dependencies, every module testable without a network or a microphone.

### Non-goals (v2)

- (Revised) Arbitrary shell and UI automation are allowed only in opt-in **Power mode** with per-call confirmation. Screenshot-based "see the screen" agent is a later milestone (M6), not v2.0.
- No multi-user, no cloud account, no server component, no phone app.
- No always-on cloud streaming of audio.
- No mac/Linux support (the code should not gratuitously block it, but nothing is tested there).
- No custom wake-word model training, no voice cloning.
- Not a FreeLLMAPI replacement or fork.

## 3. Requirements and constraints

| Area | Requirement |
|------|-------------|
| Users | One person (Dhruv), one Windows PC; maybe published later for others |
| Latency | End of speech to first spoken word: ≤ 1.5 s typical on a fast provider (target) |
| Idle RAM | Tray only, wake word off: ≤ 150 MB total across processes (target; **measure in M0**) |
| Wake word on | ≤ +40 MB, ≤ 2% CPU (target) |
| Active voice session | ≤ 600 MB peak with neural TTS loaded; models unload after ~2 min idle (target) |
| Disk | Installer ≤ 150 MB. Voice models (100-300 MB) are downloaded on first use with the user's OK, not bundled |
| Privacy | See section 8 |
| Reliability | Any provider/model can fail: failover or a spoken "I can't reach my brain" within 10 s |
| Team | 1 developer + Claude; no build step beyond Electron packaging |

## 4. Architecture

### 4.1 Processes

```
┌───────────────────────── Electron app ──────────────────────────┐
│                                                                  │
│  Renderer (UI + mic)           Main process (orchestrator)       │
│  - tray popup / transcript     - session state machine           │
│  - getUserMedia + worklet      - agent loop (LLM + tool calls)   │
│  - confirm dialogs             - provider router + key store     │
│        │  16 kHz PCM / events  - tool registry + permissions      │
│        ▼                       - memory (node:sqlite)            │
│  ┌───────────────┐   IPC       - audit log, scheduler            │
│  │ Audio worker  │◄───────────►- notification inbox + reader     │
│  │ (utilityProc) │             - updater, autostart              │
│  │ sherpa-onnx:  │                  │                            │
│  │ KWS, VAD,     │                  ├── Windows actions (PowerShell/Win32, short-lived)
│  │ STT, TTS      │                  ├── MCP client (opt-in stdio servers)
│  └───────────────┘                  └── HTTPS to chosen LLM providers
└──────────────────────────────────────────────────────────────────┘
```

Why a separate **audio worker** (Electron `utilityProcess`): native model code crashes or leaks without taking the app down, and the whole process can be killed to free model RAM when idle. The renderer stays tiny and can be destroyed when the window is hidden; the wake word then runs in the worker only.

### 4.2 Voice turn (data flow)

```
mic ──► worklet (16k PCM) ──► [Audio worker]
                               KWS (always-on, only if enabled)  ── "hey jarvis" ─┐
                               (or hotkey / mic button) ────────────────────────┤
                                                                                 ▼
                               VAD segments speech ──► streaming STT ──► partial/final text
                                                                                 │
                         fast-path intents (time, timer, volume, "stop") ◄───────┤  no LLM needed
                                                                                 ▼
                         Main: build context (system prompt + memory + history + tool schemas)
                                                                                 │
                         Router picks provider/key ──► stream tokens             │
                                   │            tool_calls ──► permissions ──► tool ──► result ─┐
                                   │                                                            │ (loop, max 5 steps)
                                   ▼◄───────────────────────────────────────────────────────────┘
                         sentence splitter ──► TTS (stream sentence by sentence) ──► speakers
                         barge-in: new speech or hotkey during playback ⇒ stop TTS, cancel request
```

### 4.3 Components

| Component | Responsibility | Notes |
|-----------|----------------|-------|
| Session manager | State machine: idle → listening → thinking → acting → speaking; barge-in; one active turn | Pure logic, fully unit-testable |
| Audio worker | KWS, VAD, STT, TTS through `sherpa-onnx-node` | Lazy model load; exposes `transcribe stream`, `speak(sentence)`, `stop()` |
| TTS fallback | Existing `speech.js` SAPI voices | Zero-download default until a neural voice is installed |
| Router | Provider catalog, key pool, quota ledger, cooldowns, streaming with first-token timeout, tool-call rescue | Section 6 |
| Agent loop | Calls the router with tools, executes tool calls through permissions, feeds results back, bounded steps and tokens | Owns the system prompt |
| Tool registry | Typed tools with JSON-schema args, risk tier, `run()`, optional `undo()` | Section 5 |
| Permission engine | Decides allow / ask / deny from tier, policy and taint; produces confirm prompts | Section 5 |
| Audit log | Append-only JSONL: time, tool, args (redacted), decision, result, undo handle | Viewer in UI |
| Memory | Conversation history, facts, notes, reminders in `node:sqlite` with FTS5 | Section 7 |
| Scheduler | Reminders and timers, persisted, survive restarts | Fires toast + voice |
| MCP client | Optional external tools via `@modelcontextprotocol/sdk` | Off by default; each server is opt-in and sandboxed by tier |
| Notification inbox + reader | Existing, kept | Contents never go to an LLM prompt |
| UI | Tray menu, small window with transcript, status orb, confirm dialog, key manager, audit viewer | Plain HTML/CSS/JS |
| Updater / autostart / DPAPI store | Existing, kept | |

### 4.4 Storage

- `settings.json` (existing pattern) for preferences.
- `keys.bin`: provider keys, encrypted with Electron `safeStorage` (DPAPI). Not saved if encryption is unavailable (existing rule, keep).
- `jarvis.db` (`node:sqlite`): `messages`, `facts` (+FTS5), `reminders`, `quota_ledger`, `audit` (or JSONL file; decide in M2), `schema_version`. Simple numbered migrations.
- Models in `%LOCALAPPDATA%\Jarvis\models\`, downloaded on demand with checksum.

## 5. Tool and permission layer

### 5.1 Tool definition

```js
{
  name: 'set_volume',
  description: 'Set system volume 0-100',
  schema: { type: 'object', properties: { level: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['level'] },
  tier: 'T1',                       // T0 read | T1 reversible local | T2 consequential | T3 never
  run: async (args, ctx) => ({ spoken: 'Volume 30', undo: { tool: 'set_volume', args: { level: previous } } })
}
```

Every call is schema-validated before it runs. Tools never get a shell string; they call fixed PowerShell scripts or Win32 APIs with validated parameters (the existing speaker process already passes text as base64 on stdin, never on a command line; keep that rule).

### 5.2 Risk tiers

| Tier | Meaning | Examples | Default |
|------|---------|----------|---------|
| T0 | Read-only, local | time, battery, CPU/RAM, list reminders, read clipboard, search files by name | Allow, log |
| T1 | Reversible local change | open app, set volume, mute, media keys, create timer/reminder, write clipboard, open URL in default browser | Allow, log, offer undo |
| T2 | Consequential or leaves the PC | move/rename/delete files (Recycle Bin only), send mail or message (MCP), close an app with unsaved work, anything from an untrusted MCP server | **Ask each time**: on-screen button and spoken yes/no |
| T3 | Power mode (opt-in) | arbitrary PowerShell, registry edits, UI automation of any app | Off by default; when on, every call confirmed with the full command. Still never registered: reading Jarvis's own key store, disabling security software, disk format |

Policy is user-adjustable (stricter only for T2/T3 in v2; relaxing T2 to "allow" is a later, explicit setting per tool).

### 5.3 Rules that matter for a voice assistant

- **Untrusted content taint.** Text from notifications, web pages, files, MCP results and email can contain instructions. After any untrusted text enters the context, T2 tools require a **button click on screen** (spoken "yes" is not enough) and the confirm dialog shows the exact arguments. Notification contents are not placed in prompts at all (existing rule, keep).
- **Voice confirmation is weak** (someone else's voice, TV, misrecognition). So T2 voice yes only counts if the confirm text was read back and the mic heard "yes" within 8 s of the prompt; otherwise cancel.
- **Path sandbox.** File tools only work under user-approved roots (default: Desktop, Documents, Downloads). Paths are normalized and checked after resolving `..`, junctions and symlinks. Delete means Recycle Bin via the shell API, which is undoable.
- **Step and cost limits.** Max 5 tool steps per turn, max 1 T2 per turn without re-asking, wall-clock cap per turn.
- **Audit log + undo.** Every call is logged (tool, redacted args, decision, outcome). "Undo that" runs the last undo handle. Undo exists for volume, mute, file move/rename, delete (restore from Recycle Bin), reminders; it does not exist for sent messages, and the UI says so before they are sent.
- **Mic indicator.** The orb shows listening state; with wake word on, a distinct icon state shows an always-on local listener (existing behaviour, keep).

### 5.5 Connectors: "use my whole PC" (added in Revision 2)

Honest map of how each app can be controlled, from safest to hackiest. Each connector is a bundle of tools with its own tiers.

| App | Best route | Notes |
|-----|-----------|-------|
| Any desktop app | Launch by name / Start-menu search; **Windows UI Automation** (UIA, built in) to read and click controls; `SendKeys` as last resort | Works with Teams, WhatsApp desktop, anything with accessible controls. Slower and less reliable than an API. |
| Spotify | `spotify:` URI scheme (search, play a URI), media keys (play/pause/next/volume); optional Spotify Web API with the user's own OAuth app for "play my Liked Songs" | Playback control through the API needs Spotify Premium; media keys and URIs work on free accounts. |
| WhatsApp | `whatsapp://send?phone=..&text=..` opens the chat with the message filled in; then UIA presses Send **after confirmation**; reading messages comes from the existing notification inbox | No official personal-account API exists. Libraries that drive WhatsApp Web (e.g. whatsapp-web.js) risk the account being banned under WhatsApp's terms, so they are **not** used. |
| Mail | MCP server for Gmail or Outlook, or Gmail / Microsoft Graph API with the user's own OAuth app; reading = T0, sending = T2 | OAuth tokens stored via DPAPI like API keys. |
| Calendar | Same as mail (Google Calendar API or Microsoft Graph); a Google Calendar MCP server exists | Create/edit events = T1 with undo (delete); inviting others = T2. |
| Teams | Deep links (`msteams:`) to open chat/meeting, UIA to click Join/Mute; Microsoft Graph chat send needs a work/school tenant and app registration | Personal accounts have limited API access; UIA path is the realistic default. |
| Browser | Open URL / search in the default browser; later, a browser MCP server or extension for page actions | Page text is untrusted content (taint rule applies). |
| Files, clipboard, windows, volume, power | Native tools in M2 | Already planned. |
| Shell | Power mode only | Command shown in full and confirmed every time. |

The same rules apply to all of them: schema-validated args, tier per tool, audit log, undo where possible, outbound messages always confirmed, injected text from messages and web pages can never confirm an action.

### 5.4 MCP

Optional. A server is added by the user with a command line, shown in full before first start, and each MCP tool is mapped to a tier (default T2 until the user lowers it per tool). Servers are started lazily and stopped after idle, because each is a separate process. No MCP server is bundled.

## 6. LLM provider router and FreeLLMAPI

### 6.1 What we build (option b)

A `router/` module of ~400-800 lines, taking these ideas from FreeLLMAPI (MIT; attribution in `NOTICE`, header kept on any copied function):

| Idea | Jarvis version |
|------|----------------|
| Provider catalog with per-model limits and capability flags | Small `catalog.json`: 6-8 vetted providers, each model has `rpm, rpd, tpm, tpd, tools, stream, ctx`. Hand-maintained, tested. Observed limits from 429 bodies override it. |
| Per-key RPM/RPD/TPM/TPD ledger with UTC-day reset | In-memory sliding windows persisted to `quota_ledger` |
| Cooldown ladder and `Retry-After` parsing | Copy/adapt the parser (seconds, HTTP date, "try again in 1m26s") |
| Failover chain, key rotation | Existing `brain.js` chain, now ordered by score |
| Health score | Simple: exponential-decay success rate × latency score. **No Thompson-sampling bandit** (overkill for ≤ 6 keys) |
| First-token timeout from observed TTFB | Per model P95 TTFB + buffer, capped; voice needs fast failover |
| Tool-call rescue | Adapt `tool-call-rescue.ts` dialect parsers (schema-gated) |
| `<think>` stripping | Adapt |

Our own additions for voice: prefer low-TTFB models for conversation turns, prefer tool-capable models when tools are in the request, **provider allowlist** (only well-known providers; lesser-known relays are never added), and a privacy class per provider (e.g. "free tier may train on data" shown in the key manager; Gemini free is flagged).

### 6.2 Options compared

| | (a) External | (b) Port ideas **(recommended)** | (c) Sidecar |
|--|--|--|--|
| Code in Jarvis | ~0 (base URL + key) | 400-800 lines | Launcher + packaging + health |
| Extra RAM | A whole second app/process (README claims ~40 MB for bare server; desktop build adds Chromium; **measure**) | None | Same as (a), plus we ship it |
| Catalog freshness | Free feed lags 30 days; premium $19/yr is the owner's choice and not required | Manual, small, we control | Same as (a) |
| Privacy control | Router may pick providers we never vetted | Allowlist enforced by us | Same as (a) |
| Failure modes | Two systems to debug | One | Two, plus version drift |
| Verdict | Keep working as an optional custom provider | Default | Skip |

### 6.3 Budget reality

A voice turn is ~1.5-3k tokens in, ~0.1-0.3k out. 100 turns a day is roughly 7.5M tokens a month, which is less than any single free tier. The binding limits are **requests per minute/day and latency**, not tokens, so the plan is: Groq as primary (fast, tool-capable, also Whisper cloud STT if wanted), Cerebras second, Gemini third, OpenRouter `:free` and NVIDIA as depth, Ollama last. See the table in `RESEARCH.md` section 3. Free-tier numbers there are a snapshot and must be re-verified when `catalog.json` is written.

The user pastes their own keys; Jarvis never creates accounts or shares keys, and does not try to avoid any provider's limits or terms.

## 7. Memory

- **Short-term**: last N turns of the current session sent to the LLM (token-budgeted). Older turns summarized by the LLM when the session ends or exceeds the budget.
- **Long-term**: `facts` table (text, tags, source, created, last_used). Jarvis stores a fact only when the user says "remember ..." or confirms ("Should I remember that?"). Retrieval: FTS5 keyword search over facts and notes, top-k injected into the prompt. No embeddings in v2 (saves RAM and a provider dependency); revisit if recall is poor.
- **User control**: "what do you remember", "forget X", "forget everything", plus a viewer/exporter in the UI. Memory never contains notification contents, secrets or keys; a filter rejects strings that look like keys/passwords.
- **Privacy**: memory text that is sent to a cloud LLM is only what retrieval selects for the current turn, and the key manager shows which provider you are using.

## 8. Privacy and security model

- Mic: open only while listening (orb on) or when the optional local wake-word listener is enabled and visibly indicated. Audio is processed locally by default; Groq cloud STT is an explicit opt-in.
- Network: only to LLM providers the user keyed, model download hosts (checksummed, with user consent), and the GitHub update feed. No telemetry.
- Keys: DPAPI via `safeStorage`; never logged; error messages redacted (adapt FreeLLMAPI's log-redaction idea).
- Electron hardening: `contextIsolation`, no `nodeIntegration`, strict IPC sender checks (existing code already checks sender; keep), CSP, no remote content in renderers, `will-navigate` blocked.
- Prompt injection: taint rule (5.3), tools cannot exceed their tier, tool results are data, system prompt says so, and nothing sensitive is reachable by a tool anyway (no T3).
- Supply chain: few dependencies (`sherpa-onnx-node`, `@modelcontextprotocol/sdk`, `electron-updater`), versions pinned, lockfile committed, `npm audit` in the release checklist, model downloads verified by SHA-256.

## 9. Architecture decisions (ADRs)

### ADR-1: Keep Electron (not Tauri, not native)

- **Context:** RAM-tight PC; existing, tested Electron app; user and Claude work in JavaScript.
- **Options:** Keep Electron 44. Rewrite in Tauri (Rust + WebView2). Pure native tray app.
- **Decision:** Keep Electron. Mitigate with: no window means no renderer (tray + utility process only), lazy model loading, destroying the renderer when hidden, audio worker kill on idle.
- **Trade-offs:** Tauri could save roughly 100+ MB at idle (**not measured**), but costs a Rust rewrite of everything with no payoff in features, and splits the toolchain. sherpa-onnx has Tauri demos, so the door stays open.
- **Revisit when:** measured idle memory in M0/M5 exceeds the budget and cannot be fixed with the mitigations.

### ADR-2: Node-only audio stack (sherpa-onnx) instead of a Python sidecar

- **Options:** (1) `sherpa-onnx-node` addon. (2) Python sidecar with faster-whisper, Piper, openWakeWord (RealtimeSTT-style). (3) whisper.cpp + separate TTS binaries.
- **Decision:** (1), in a `utilityProcess`.
- **Why:** one Apache-2.0 dependency for KWS, VAD, STT and TTS; prebuilt Windows binaries (~23 MB package); no Python install for end users; no GPL (piper1-gpl and openWakeWord's non-commercial models avoided).
- **Trade-offs:** fewer model choices than the Python world; we depend on one maintainer group (active: pushed 2026-10-23). N-API addon inside Electron needs an M0 spike to confirm.
- **Fallback if the spike fails:** run sherpa-onnx's own C++ CLI/WebSocket server as a child process (same models, same API shape).
- **Revisit when:** accuracy on the user's voice is bad on every sherpa-supported model (then add whisper.cpp as an optional component).

### ADR-3: Default models

- **TTS (revised after Spike C):** Kokoro int8 was too slow on this PC (RTF 2.4) and Piper is blocked by sherpa-onnx 2.0 needing a GPL phonemizer. SAPI stays the default until the M1 TTS shootout finds a voice with RTF below 0.5 here. See M0 results for candidates.
- **STT (decided after Spike C):** VAD + Moonshine base en. Confirm on the user's own recorded phrases in M1 (accent test). Groq Whisper stays as optional cloud STT.
- **Wake word:** sherpa-onnx keyword spotter with text keywords "hey jarvis" / "okay jarvis". Needs false-accept tuning (M1 acceptance test).

### ADR-4: Agent and tool protocol

- **Options:** (1) In-process tool registry using the OpenAI function-calling format, MCP client for extras. (2) MCP for everything (even built-in tools). (3) Prompt-parsed JSON commands (what `brain-prompt.js` does today).
- **Decision:** (1).
- **Why:** built-in tools need tight permission control and tiny latency, MCP adds a process per server. OpenAI tool format is what every free provider speaks. Prompt-parsed JSON is fragile; tool-call rescue covers the models that print tool calls as text.
- **Trade-offs:** two paths (native and MCP) to keep consistent. Both go through the same permission engine, so the model does not know the difference.

### ADR-5: Own router, port ideas (FreeLLMAPI option b)

See section 6. **Revisit when:** more than ~8 providers are in regular use, or catalog upkeep becomes a chore (then option a becomes more attractive).

### ADR-6: Plain JavaScript with JSDoc types, `node:sqlite`

- **Decision:** CommonJS JS (as now) with `// @ts-check` and JSDoc on public module functions; no bundler. SQLite through built-in `node:sqlite` (Node 24 ships in Electron 44, **verify** in M0), avoiding a native `better-sqlite3` rebuild.
- **Trade-offs:** weaker typing than TypeScript; zero build step, which suits one developer.

### ADR-7: Fast path before the LLM

Deterministic intents ("what time is it", "set a timer for 5 minutes", "volume 30", "stop", "what did I miss") are answered locally without calling an LLM: faster, free, offline. The LLM is used when no intent matches.

## 10. Code: keep, change, delete (file by file)

Current repo: Electron 44, ~5.6k lines. "Karen" is the old Spidey Sense name still present in code.

| File | Decision | What happens |
|------|----------|--------------|
| `main.js` (574) | **Refactor** | Keep window, tray, settings, IPC sender checks. Split into `app/` modules (window, tray, settings, ipc). Remove Spidey leftovers. |
| `preload.js`, `preload-brain.js` | **Keep, extend** | Add new IPC channels; keep the narrow-API pattern. |
| `brain.js` (582) | **Evolve into `router/`** | Keep: presets, DPAPI key store, cooldown, failover, streaming, injected fetch/clock/storage (good test design). Add: ledger, catalog, TTFB timeout, tool-call support. Rename Karen strings. |
| `brain-prompt.js` (201) | **Rewrite mostly** | Keep sanitizing and the "only a short status line goes to the model" rule. Delete `ALLOWED_ACTIONS` (Spidey-only actions: locker, equip, bugle, edith, capture, collapse, opacity...), replaced by the tool registry. |
| `karen-llm.js` (115) | **Delete** | Ollama becomes a normal provider in the router. |
| `speech.js` (318) | **Keep as fallback** | SAPI TTS with persistent PowerShell speaker. Becomes the zero-download fallback behind a common `Voice` interface. |
| `stt.js` (140) | **Keep, demote** | Groq Whisper path stays as cloud option; SAPI offline STT is removed once local sherpa STT passes the M1 test. |
| `wake.js` (172) | **Replace** | Delete after sherpa KWS passes M1 tests; keep until then. |
| `notifications.js` (163) | **Keep** | Works; privacy model is right. |
| `autostart.js`, `updater.js` | **Keep** | Tested. |
| `renderer/index.html`, `style.css`, `jarvis.js` | **Rewrite** | New small UI: orb, transcript, confirm dialog. Reuse styles that survive. |
| `renderer/voice.js` (236) | **Rewrite** | Capture only; stream PCM to the audio worker. VAD moves out. |
| `renderer/voice-core.js` (125) | **Trim** | Keep resample/WAV helpers if still used; delete energy VAD once sherpa VAD is in. |
| `renderer/pcm-worklet.js` | **Keep** | |
| `renderer/inbox.js`, `reader.js` | **Keep** | |
| `renderer/brain.html/css/js` | **Keep, rename** | Becomes the Providers/Keys window; add allowlist, privacy class and usage display. |
| `scripts/*-test.js` | **Keep, adapt** | One test file per surviving module; rename with the code. Add new suites per milestone. |
| `scripts/e2e.js`, `make-fake-mic.js`, `make-fixtures.ps1` | **Keep, extend** | Fake provider gains tool-call responses; fake mic gains command phrases. |
| `scripts/dist-local.ps1`, `build/installer.nsh` | **Keep** | Review in M5. |
| `scratch/*.js` (Spidey cut scripts, `fixplan.js`...) | **Delete locally** | Untracked leftovers from the split; git-ignored. |
| `README.md` | **Rewrite in M5** | |

Nothing is deleted until the user approves this plan, and deletions happen in M0 with the tests green before and after.

## 11. Testing strategy

- **Unit** (fast, no network, no mic): every module takes injected `fetch`, clock, storage, spawn (current style). New suites: router (ledger, cooldown, failover, tool-call rescue fixtures), permissions (table-driven: every registered tool × tier × taint state), path sandbox (traversal, junction, UNC, case, long paths), scheduler, memory, fast-path intents, agent loop (scripted fake LLM).
- **Golden audio**: a few recorded WAVs of the user's voice and synthetic ones; assert WER below a threshold for STT, wake word fires on "hey jarvis" and not on 10 near-miss phrases and 5 minutes of TV-like speech.
- **E2E** (`scripts/e2e.js` pattern): launch the real app with fake mic WAV, fake provider server that streams text and tool calls, speech log in dry-run mode; assert sentence-by-sentence speech, that a T2 action waits for confirmation and a click proceeds, audit log written, undo works.
- **Security tests**: injected text in a fake notification and fake web result tries to trigger a T2 tool; assert it needs the click.
- **Resource tests**: script that records process working set at idle, wake on, and during a voice turn, and fails if it exceeds the budget by > 20%.
- **Release checklist** (manual): clean-VM install, upgrade from previous version, mic permission denied path, offline path, no-keys path.

## 12. Milestones

Each milestone ends with tests green and a short demo script. Rough sizes are for one developer with Claude, in focused sessions.

### M0: Baseline cleanup and spikes (about 1-2 sessions)

- Rename Karen leftovers, delete dead Spidey actions, delete local `scratch/` junk, split `main.js`, add `NOTICE`.
- Record baseline: `npm run test:unit` and `node scripts/e2e.js` pass; measure idle/active memory of the current app.
- Spike A: `sherpa-onnx-node` loads in Electron 44 `utilityProcess`; runs VAD on a WAV. Spike B: `node:sqlite` works in Electron main. Spike C: measure RAM of Kokoro TTS and a streaming STT model loaded.
- **Acceptance:** existing tests green; spike results written to `RESEARCH.md`; go / no-go on ADR-2 recorded; baseline numbers recorded. If spike A fails, switch to the sherpa child-process fallback before M1.

### M1: Better voice (2-4 sessions)

- Audio worker with VAD, streaming STT, KWS, TTS; `Voice` interface with SAPI fallback; model downloader with checksums and consent; barge-in.
- Benchmark STT models on the user's recorded phrases and choose the default.
- **Acceptance:** (1) 20 recorded phrases: WER under agreed threshold (set after benchmark, target ≤ 10%). (2) Wake word fires ≥ 9/10 on "hey jarvis", ≤ 1 false trigger in 30 minutes of normal speech/TV (manual). (3) First spoken word ≤ 1.5 s after end of speech on a fast provider. (4) Saying something during playback stops speech within 300 ms. (5) Idle with wake word on stays within the budget. (6) Works fully offline except the LLM call. (7) Old SAPI STT/wake code deleted, tests updated.

### M1 results so far (2026-10-24)

Built and passing (unit: `npm run test:unit`, real app: `npm run e2e`):
- `audio/` worker process (Electron utilityProcess) with Moonshine STT, Piper TTS and the keyword spotter, lazy-loaded, killed after 2 minutes idle. Model installer (`audio/models.js`): asks first with name, size, source and license; SHA-256 (npm: SHA-512) checked before unpacking; archives listed and refused if any path escapes the target folder; staged then moved into place. Tray: "Download voice models…".
- **Natural voice**: Piper "Alan" (British) through sherpa-onnx, phonemizer (GPL, downloaded as a separate optional component, never linked) in the models folder. Speaks about 4-6x faster than real time on this PC (RTF 0.17-0.26), sentence by sentence, one sentence ahead. Falls back to the Windows voice per sentence if anything fails, and rests 60 s.
- **On-PC speech recognition** in the real app: the fake microphone's "what is my cpu" was transcribed by Moonshine. Found and fixed: Moonshine returns nothing when a clip starts with seconds of room noise, so `trimSilence` cuts to the speech first.
- **On-PC wake word** in the real app: a spoken "Hey Jarvis" wakes it, plain speech does not (`scripts/e2e-wake.js`, one sample each).
- Two Electron-specific bugs found and fixed: sherpa's TTS returns native-owned buffers that Electron refuses ("External buffers are not allowed"; fixed with `enableExternalBuffer: false`), and `autoplayPolicy` had to allow audio without a click.
- The old Windows speech recogniser path and the Windows wake word stay as fallbacks for when the models are not installed (they were meant to be deleted; keeping them costs nothing and the app still works with zero downloads).

**Memory measured (`scripts/measure-ram.js`, whole process tree):** idle with window, wake word off: **287 MB**; wake word listening: **449 MB**; after speaking a reply (voice model loaded): **537 MB**. This is **over the budget** in section 3 (150 MB idle, +40 MB for wake word). Causes: a full Chromium renderer is needed for microphone capture, plus the audio worker. Planned fix in M5: no window = no renderer for the plain tray state, and the wake-word capture moved to the smallest possible hidden page.

Still open for M1 acceptance: (1) WER on 20 of the user's own recordings, (2) false-wake rate over 30 minutes of TV/speech, (3) end-of-speech to first spoken word timing with a real provider, (4) barge-in by voice (speaking over Jarvis; needs echo cancellation, hotkey/mic button already stops him), (5) RAM budget (above).

### M2: Tools, actions and permissions (3-5 sessions)

- Tool registry, permission engine, audit log, undo, confirm UI; agent loop with bounded steps.
- First tools: `open_app`, `open_url`, `set_volume`/`mute`, media keys, `set_timer`/`add_reminder`/`list_reminders`, `read_clipboard`/`write_clipboard`, `find_files`, `open_file`, `move_file` (T2), `delete_file` (T2, Recycle Bin), `system_status`, `read_notifications_summary` (local only).
- Fast-path intents for the common ones.
- Optional MCP client behind a setting, with one example server tested.
- **Acceptance:** (1) "Open Notepad", "volume 30", "remind me in 10 minutes to stand up" work by voice. (2) "Delete the file X" shows the exact path, needs click plus yes, goes to Recycle Bin, "undo" restores. (3) Prompt-injection test cannot trigger a T2 tool without a click. (4) Path traversal tests all denied. (5) Audit log shows every call; viewer works. (6) With Power mode off, no T3 tool is in the registry (test enumerates it); the key store and security-software tools never exist. (7) Tool loop stops at max steps.

### M2 results (2026-10-24)

Built, with unit tests (`npm run test:unit`, now 22 suites) and real-app tests (`npm run e2e`, 4 scripts):
- **Tool runtime** (`tools/runtime.js`): one gate for everything Jarvis can do. Tools are registered with a tier and a JSON schema; arguments (from a model, which is treated as hostile) are validated and unknown properties refused; T2 always asks; T3 only with power mode; a tool the user switched off is invisible to the model and cannot be called; every call is logged; undo stack of 20.
- **Tools** (`tools/windows.js`): open_app, open_url (http/https only), set_volume, mute, media_key, set_timer, add_reminder, list_reminders, cancel_reminder, read_clipboard, write_clipboard, system_status, find_files, open_file (never programs or scripts), move_file (T2), delete_file (T2, Recycle Bin, files only). All PowerShell is a fixed script; the only variable is a base64 JSON argument, never pasted into a command line.
- **File sandbox** (`tools/paths.js`): approved folders only, judged after resolving `..`, junctions and symlinks; network, device and alternate-stream paths and reserved names refused.
- **Confirmation** (`renderer/confirm.js`): a box on screen showing the exact action; a spoken yes or no works when nothing untrusted has been read; **after reading untrusted text (clipboard, file names) a spoken yes is refused and only the click counts**.
- **Agent loop** (`agent.js`): at most 5 steps and 4 calls per step, duplicate calls dropped, results labelled "UNTRUSTED CONTENT" for the model, tool calls written as text by some models are rescued (`tools/rescue.js`), a half-streamed tool call is never run. `brain.js` now streams and returns tool calls.
- **Fast path** (`fastpath.js`): "open Spotify", "volume 30", "set a timer for five minutes", "remind me in 20 minutes to stretch", "next song", "mute", "what time is it", "undo that" run with no language model, so they work offline and with no keys.
- **Activity log** (`activity.jsonl` in the app data folder, redacted, rotated at 2 MB), tray: Activity log, Undo last action, per-tool on/off, master switch.
- The Spidey-era "DO:" action protocol and its action whitelist are gone.

Verified for real on this PC (not just fakes): the PowerShell volume, mute, Start-menu app list and CPU/battery scripts, and a **real Recycle Bin delete and restore** of a temp file.
Verified in the real app with a stand-in for PowerShell and a scripted fake provider (`scripts/e2e-tools.js`): fast-path commands without any provider call, a model-requested tool, DENY keeps the file, a spoken yes allows it, undo brings it back, and the **prompt-injection case** (clipboard says "delete the tax file", the fooled model asks to delete): a box appears that demands a click, a spoken "yes" does nothing, and the file stays.

Not done yet from the M2 list: the optional MCP client (moves to M2b with the connectors), a graphical activity viewer (the tray opens the log file), voice confirmation uses a 90-second window and no read-back. Power mode has no tools yet (M2b).
Found while testing: a model that is fooled can still ask; the safety is in the runtime, not in the prompt. Worth keeping in mind for every connector.

### M2b: Connectors, the Iron Man layer (4-6 sessions, one connector at a time)

Order by value for Dhruv: Spotify (URI + media keys), Calendar and Mail (OAuth or MCP, read first, then write), WhatsApp (URI + UIA send with confirmation, notification-based reading), Teams (deep links + UIA), generic UIA "click/type in app X", then Power mode.
- **Acceptance per connector:** one voice command end to end against a fake target in tests (fake app window or fake API server), one manual run on the real app; outbound actions show recipient and text and wait for confirmation; audit entry written; token storage uses DPAPI; connector can be disabled in settings.
- Power mode acceptance: off by default; every command shown in full; denied commands never run; a prompt-injection fixture cannot reach it.

### M2b progress (2026-10-24)

**Spotify: done for a free account.** Verified against the real Spotify desktop app on this PC: a `spotify:track:...:play` link started the song after a cold launch (about 7 s), the window title gave "Never Gonna Give You Up by Rick Astley", and a media key paused it.
- Tools: `spotify_now_playing`, `spotify_search`, `spotify_play` (a spotify: URI or open.spotify.com link; tracks, albums, playlists and episodes start, artists and shows open), `spotify_open_liked_songs`; the existing media keys do play, pause, next and previous. Voice: "what's playing", "play despacito on spotify" (opens Spotify's search; you press play), "play my liked songs", "next song".
- **Limit, and why:** "play song X" cannot start by name on a free account. Since February 2026 Spotify only lets Premium accounts create developer apps (TechCrunch, 2026-02-06), so there is no free route to search through the API. Only fixed spotify: links are ever opened. If the account becomes Premium, the Web API can be added behind the same tool names.
- Design finding: results of fast-path commands are only spoken and shown, never given to the language model, so they do not mark the conversation as tainted. (Tainting them made a later confirmation demand a click for no reason.)

**Mail and calendar guides written, no code yet:** `docs/setup/README.md`, `google-mail-calendar.md`, `microsoft-mail-calendar-teams.md`. Key facts checked against Google's and Microsoft's own pages: Google Desktop-app client with a loopback redirect and PKCE; an External app left in Testing gets a refresh token that expires in 7 days, so the guide says to publish it (unverified-app screen is expected); Microsoft app registration as "any Entra ID tenant + personal accounts", public client, `http://localhost`. Not verified from here: whether a personal Microsoft account can register an app without an Azure sign-up (the guide says what to do if not), and which Teams permissions your employer lets you approve.

**Next in M2b:** the Accounts window with Google and Microsoft sign-in (PKCE, DPAPI token store), then Calendar and Mail read tools, then the write tools with confirmation; WhatsApp and Teams (deep links plus UI automation); optional MCP client; Power mode.

### M3: Memory (1-2 sessions)

- SQLite schema + migrations, history, facts with FTS5, session summaries, memory commands, viewer/export, secret filter.
- **Acceptance:** "Remember my sister's name is Asha" then, after an app restart, "what's my sister's name" answers correctly; "forget that" removes it; a string that looks like an API key is refused; memory survives updates; DB migration test from v1 to v2 schema.

### M4: Free-LLM router and FreeLLMAPI option (2-3 sessions)

- `router/` with catalog, ledger, cooldowns, TTFB timeouts, tool-call rescue, allowlist, privacy labels, usage view. `NOTICE` attribution.
- Docs for option (a): how to add a locally running FreeLLMAPI as a custom provider (with the privacy warning that its router may choose providers outside the allowlist).
- **Acceptance:** (1) Fake-provider tests: 429 with `Retry-After` benches the key and fails over within one turn; a hung first token fails over in ≤ TTFB budget; daily-limit exhaustion skips a key until UTC midnight; tool-call-as-text fixtures are rescued for 4 dialects. (2) Real smoke test with the user's own keys (manual): a turn succeeds when the top provider is blocked. (3) Pointing at a local FreeLLMAPI instance works as a custom provider (manual, only if the user runs it). (4) No key ever appears in logs (grep test).

### M5: Packaging, update and release (1-2 sessions)

- Installer review, auto-update test across two versions, first-run wizard (mic, optional models, keys), README, privacy page, resource-budget script in the release checklist. Publishing to GitHub only when the user says so.
- **Acceptance:** clean Windows VM install works; upgrade from previous build keeps settings/keys/memory; budget script within limits; release checklist signed off; license/NOTICE audit passes (no GPL, no non-commercial models bundled).

### M6: Full Iron Man polish (after v2.0)

Arc-reactor HUD orb and ambient UI, proactive briefings ("good morning, 3 meetings, 12 unread"), "you have a call from Mum" interrupts, screenshot-based screen understanding for apps without accessible controls (vision-capable provider, T2 confirmations), multi-step plans spoken back before running. Each needs its own mini-design before starting.

### M0 results so far (2026-10-24)

- Baseline `npm run test:unit`: all 11 suites pass after fixing a timing flake in `scripts/stt-test.js` (temp-file deletion check waited 30 ms; now polls up to 1 s). `node scripts/e2e.js` not yet re-run on this machine.
- Karen strings renamed to Jarvis in source comments and the local-model system prompt; Spidey-themed prompt removed.
- Local `scratch/` leftovers from the Spidey split deleted (git-ignored files only).
- **Spike A passed:** `sherpa-onnx-node@2.0.0` (Apache-2.0) installs (23 MB Windows x64 package) and loads inside an Electron 44.7.2 `utilityProcess` in 13 ms (worker RSS 54 MB). It exports `KeywordSpotter`, `OnlineRecognizer`, `OfflineRecognizer`, `OfflineTts`, `Vad`. No model has been loaded yet.
- **Spike B passed:** `node:sqlite` works in the Electron main process (Node 24.21) including an FTS5 virtual table.
- **Spike C done (models downloaded 2026-10-24, SHA-256 checked against the release checksum files, extracted into git-ignored `models-dev/`).** Machine: Core Ultra 5 125H, 15.8 GB RAM, about 3.4 GB free at test time. Scripts: `scripts/spikes/spike-c.js`, `spike-kws.js`, `spike-tts-threads.js`, `bpe.py`.

| Part | Model | Result |
|------|-------|--------|
| STT | Moonshine base en (quantized, 106 MB archive) | **Winner.** 6.6 s clip decoded in about 0.65 s (RTF ~0.1), correct words, case and punctuation. Transcribed a synthetic "Hey Jarvis, what is the time right now?" exactly. About +200 MB RSS when loaded. Utterance-level (use after VAD), no live partials. |
| STT | Streaming zipformer en 20M (121 MB archive) | Fast (RTF ~0.09), live partials, but worse: "BRAFFLELS", and "Y JARVIS" for "Hey Jarvis". Keep only if live partial text in the UI matters. |
| Wake word | KWS zipformer gigaspeech 3.3M (17 MB) | **Works** once the keyword is tokenised with the model's own BPE model (`HEY JARVIS` becomes `▁HE Y ▁JA R VI S`). Detected "hey jarvis" in a test clip. About +25 MB RSS. False-accept rate on TV and speech not measured yet. Keywords will ship pre-tokenised (sentencepiece is only a dev-time tool). |
| VAD | Silero v5 (2 MB) | Loads fine. Not yet timed on live audio. |
| TTS | Kokoro int8 en v0.19 (98 MB) | **Too slow here.** RTF 2.4 with 2 threads (5.7 s to speak 2.4 s of audio), 2.7 with 1 thread, 6.7 with 4 threads. About 455 MB RSS after the first synthesis. Quality is good but it cannot talk in real time on this PC. Also, sherpa-onnx 2.0 needs a separate `lexicon-en-us.txt` (6 MB, from the same release) because it dropped built-in espeak. |
| TTS | Piper lessac-medium int8 (19 MB) | **Blocked.** sherpa-onnx 2.0 removed built-in espeak phonemizing. Piper needs an external phonemizer (`piper-phonemize-node`, GPL-3.0-or-later), and without one the native library crashes (segfault, exit 139). |

Memory with everything loaded at once was 744 MB RSS, so models must be loaded on demand and unloaded when idle, as already planned.

**What this changes (ADR-3 updated):**
- STT default: VAD + Moonshine base en. Wake word: sherpa KWS. Both confirmed.
- TTS is the open problem. M1 starts with a TTS shootout and the default stays Windows SAPI until one candidate runs at RTF below 0.5 on this PC. Candidates: (1) Kokoro fp32 (304 MB archive; int8 may be the slow variant, since dynamic int8 can be slow on some CPUs), (2) Piper British male "alan" voices (very Jarvis) with the GPL phonemizer downloaded as an optional component, since Jarvis is free and open source and the phonemizer is not linked into the app, (3) pinning sherpa-onnx 1.x that still bundles espeak, (4) a smaller VITS voice with a lexicon, (5) optional cloud TTS as a user choice. Needs your decision on GPL (see open questions).

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `sherpa-onnx-node` does not work well inside Electron | Low-med | High | M0 spike; fallback to sherpa child process |
| Neural TTS or STT uses too much RAM on the 97%-full PC | Medium | High | Measure in M0; small voice option; unload on idle; SAPI fallback always works |
| Wake word false triggers or misses | Medium | Medium | Tune threshold; acceptance test; hotkey always available; user can disable |
| STT accuracy poor on the user's accent | Medium | Medium | Benchmark on real recordings; Whisper option; Groq cloud STT opt-in |
| Prompt injection via notifications/web/MCP | Medium | High | Taint rule, tiers, no T3, no notification text in prompts, click-to-confirm |
| Voice confirmation spoofed or misheard | Medium | Medium | T2 needs on-screen click when tainted; read-back; 8 s window |
| Free tiers change or vanish | High | Medium | Catalog is data; observed limits override; multiple providers; Ollama; clear error spoken |
| Free provider privacy (Gemini free may train on data) | Certain | Medium | Privacy label in key manager; user picks; allowlist; no sensitive local data in prompts |
| FreeLLMAPI changes API or license | Low | Low | We only copy small MIT parts with attribution; option (a) is a plain OpenAI endpoint |
| Scope creep (this is a big wish list) | High | Medium | Milestones are independent releases; M2 tool list is the cap |
| Native module/ASAR packaging problems | Medium | Medium | `asarUnpack` for the addon, tested in M5 on a clean VM |
| Microphone/privacy perception | Low | Medium | Visible indicator, local-first, privacy page |

## 14. What I would revisit as it grows

- Embeddings for memory once facts exceed a few thousand.
- Whisper or a larger STT as an optional component if accuracy is the top complaint.
- Tauri if memory is still too high after M5.
- A plugin/skills format (Goose recipes, Leon skills as inspiration) once there are more than ~20 tools or someone else wants to add one. v2 deliberately keeps tools in-repo.
- Proactive features (morning brief, "you missed a call") after the permission model has proved itself.
- Screen understanding / computer use: only with a new security review.

## 15. Open questions for Dhruv

1. **Approve overall direction?** Keep Electron, sherpa-onnx for voice, own router with FreeLLMAPI ideas (option b), FreeLLMAPI optional as an external provider.
2. **Delete vs refactor:** OK to follow the file-by-file table in section 10 (refactor and delete in M0, not a blank-slate rewrite)?
3. **Languages and accent:** only English, or also Hindi/Gujarati? This changes the STT and TTS model choice a lot.
4. **Voice quality vs RAM:** is a ~100-300 MB downloaded neural voice acceptable on this PC, or should the default be the smaller Piper voice?
5. **Action list:** is the M2 tool list right? Anything you most want (WhatsApp, calendar, mail, YouTube/Spotify control, window management)? Mail/calendar/messages would come through MCP and be T2.
6. **Providers:** which free keys do you already have (Groq, Gemini, NVIDIA, OpenRouter, others)? Any provider you want excluded?
7. **Name and branding:** keep "Jarvis" (a Marvel-owned name; fine for a private project, a concern if published) or pick a distinct public name?
8. **Publishing:** keep local only for now, or plan a GitHub repo and releases at M5?
9. **Wake word always-on:** acceptable default-off (current) or default-on after setup?
