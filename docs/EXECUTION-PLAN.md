# Execution plan: best possible voice capture, and one proper Jarvis window

Written 2026-10-24 on the owner's instruction: *plan first, then execute, always.* Two workstreams, run in the order below. Each step has a test or a measurement that says it is done, and is committed on its own.

## Workstream V: capture the voice as well as possible (wake word and talk)

Goal (from [VOICE-ACCURACY.md](VOICE-ACCURACY.md)): at least 95 of 100 "Hey Jarvis" wake him, at most one false wake-up an hour, speech word error rate of 8 percent or less on the owner's own sentences. Everything gets a fallback, so one broken part never leaves Jarvis deaf.

| Step | What | Done when |
|------|------|-----------|
| **V1. NVIDIA Parakeet** | Add Parakeet TDT 0.6B v2 (int8, English, about 460 MB) to the model installer with a pinned checksum; load it in the audio worker; support hotwords ("Jarvis", contact names); download it here and measure speed, memory and accuracy against Moonshine on the same audio | It transcribes real audio in the app; numbers recorded |
| **V2. Engine chain with fallbacks** | One ordered chain per mode. *Most accurate:* Groq Whisper, then Parakeet, then Moonshine, then Windows. *Private:* Parakeet, then Moonshine, then Windows. A result that is empty or looks like noise automatically falls through to the next engine. Whisper gets a vocabulary prompt (Jarvis, WhatsApp, Spotify, contact names) | Unit tests for every fall-through, including "engine throws", "empty text", "model not installed" |
| **V3. Capture pipeline** | Fix what can lose or damage words: a 400 ms pre-roll so a quiet first syllable is never cut; end-of-speech by the Silero voice-activity model instead of an energy gate; a proper low-pass resampler to 16 kHz in place of linear interpolation; the microphone processing (echo cancellation, noise suppression, automatic gain) made a setting with the measured best as default; an explicit microphone picker | Tests on recordings with quiet starts, noise and different sample rates; the pre-roll keeps the first word |
| **V4. Wake word that actually wakes** | (a) loosen and tune the keyword spotter with more spoken variants; (b) two-stage confirm: the loose trigger, then the speech model checks the last 2 seconds for "Jarvis" before waking, so loose does not mean false alarms; (c) automatic fallback to the Windows wake recogniser if the model cannot start; (d) push-to-talk always works; (e) a clear wake sound and an on-screen hint when the word was almost heard | Synthetic test set (many voices, speeds, noise levels) shows high hit rate and few false wakes; the real numbers come from step V6 |
| **V5. Voice health** | Show, in the app, what the microphone hears (level), what was recognised and by which engine, and how long it took; a "voice health" line that says what is wrong (no mic, muted, blocked, model missing, Groq down) | The page exists and each message is reachable in a test |
| **V6. Voice Lab** | In the settings window: record your own phrases once (private, local), then score every engine and every wake setting on them; apply the best | You can see word error rate and wake hit rate for your own voice, and one button applies the winner |

## Workstream U: one Jarvis window, like the film

Today there are four windows (main, AI keys, Accounts, Setup). They become **one**: a full Jarvis presence with the settings inside it.

**Look and behaviour (the movie Jarvis):**
- The centre is **the orb**: concentric glowing rings with a bright core, drawn live. **Idle:** slow rotation and a faint breathing pulse. **Listening:** the rings swell and ripple with your voice. **Thinking:** gold arc segments sweep around. **Speaking:** the rings flow outward with his voice. **Asking permission:** the orb turns amber and the question rises under it. **Error / offline:** a dim red ring.
- Around it, quiet HUD readouts in thin cyan lines: time, CPU and memory, battery, microphone and wake word state. Nothing else crowds the view.
- What he says and what you said appear as **a caption under the orb**, line by line, fading. The **full conversation** slides in from the side on demand (button or key), not permanently.
- A thin **bar at the bottom**: type a message, the microphone button, and the confirmation box when he needs a yes.
- Top right: the **Settings** gear and the notification inbox.

**Settings inside the same window** (a full-window page that slides over the orb, with a list on the left; Esc or the orb button returns):
1. **General:** speaks replies, conversation mode, launch at startup, morning briefing, always on top.
2. **Voice and wake word:** speech mode (most accurate or private), microphone picker and level, wake word on/off and sensitivity, voice models (download), the Voice Lab.
3. **AI brain:** keys, order, smart order, usage and privacy notes (what the AI keys window does now).
4. **Accounts:** Google (and Microsoft later).
5. **Tools and permissions:** the tool list with switches, Power mode, screen understanding (the warning boxes stay in the main process, so a web page can never switch them on).
6. **Memory and contacts:** see, edit, delete.
7. **Activity log:** what he did, with undo.
8. **Setup guide** (first run) and **About**.

| Step | What | Done when |
|------|------|-----------|
| **U1. The orb** | New canvas orb with the five states, driven by the same signals as today (voice state, mic level, speaking); paused when the window is hidden so it costs nothing | Screenshots of each state; CPU stays low (measured) |
| **U2. New main layout** | Orb centre, caption, HUD readouts, bottom bar, sliding conversation drawer; the confirmation box and inbox re-skinned to fit | All existing end-to-end tests pass unchanged (their element ids are kept) |
| **U3. Settings shell** | Left list, page container, routing, keyboard (Esc), one preload exposing every settings API to this window only | Every page opens; no other window is created |
| **U4. Move the pages in** | AI brain, Accounts and Setup become pages of the settings shell; the old windows and their preloads are deleted; the main-process checks accept only the one window | Their end-to-end tests are updated and pass; `grep` finds no second `BrowserWindow` for them |
| **U5. New pages** | General, Voice, Tools and permissions, Memory and contacts, Activity log | Each page reads and changes real settings; risky switches still go through main-process warning boxes |
| **U6. Polish and checks** | Screenshots of every page, keyboard and screen-reader labels, window size and position memory | Screenshots reviewed; accessibility checklist done |

## Order of work

1. **V1, V2, V3** (engines, fallbacks, capture): no new window needed, biggest effect on "wrong words".
2. **U1 to U4** (the orb, the single window, settings shell with the old pages moved in).
3. **V4, V5, V6** (wake word, voice health, Voice Lab) as pages of the new settings, so they are built once.
4. **U5 and U6**, then a full test run, a new installer, and a release when the owner says so.

## Rules for this work

- Every step: tests first or with it, `npm run test:unit` and `npm run e2e` green, then a commit; the plan file is updated with what really happened, including what did not work.
- The safety rules in [CONTRIBUTING.md](../CONTRIBUTING.md) do not bend for convenience: confirmations, untrusted text, no secrets, privacy by default.
- Measure before and after any accuracy claim; real numbers need the owner's recordings (Voice Lab), until then the tests use synthetic voices and say so.
