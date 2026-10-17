# Jarvis

A voice-first AI assistant for Windows. Talk to it, ask it things, let it read your notifications aloud.

Jarvis started life inside [Spidey Sense](https://github.com/DhruvHarani1/spidey-sense) (as "Karen") and was split out so that Spidey can stay a small, sharp danger-sense widget. See `FOCUS-PLAN.md` in that repo for the reasoning.

## What it does (Phase 1 = everything voice from Spidey 0.2.7)

- **Talk**: Ctrl+Alt+Space (or the mic button). Speak, he answers aloud sentence by sentence while still thinking.
- **Wake word** (opt-in, offline): say "Hey Jarvis" / "Okay Jarvis". Tray menu or say "turn on the wake word".
- **AI brain**: free API keys (NVIDIA, Groq, Gemini, OpenRouter, custom) with automatic failover, then local Ollama. Keys are encrypted with Windows DPAPI.
- **Speech to text**: Groq Whisper when you have a Groq key, otherwise Windows' offline recogniser ("Windows only" in the tray keeps audio on the PC).
- **Notification inbox + reader**: every Windows notification in one list; optionally read aloud ("Dhruv sir, you received a message from Mum on WhatsApp…"), private mode says who but not what.
- **Voices**: switch between the Windows voices ("change voice").

Jarvis cannot act on the PC yet (no commands, no process control): conversation only. That is deliberate for Phase 1.

## Privacy

Microphone is open only while the blue reactor pulses (or, with the wake word on, a small offline recogniser listens for the wake phrase only; nothing is recorded or sent). API keys never leave the PC except to their own provider. Notification contents are never sent to an AI provider.

## Develop

```
npm install
npm start
npm run test:unit      # fast unit + wiring tests
node scripts/e2e.js    # drives the real app (fake mic, fake wake WAV, fake AI provider)
```

`scratch/` holds generated test fixtures (fake microphone WAV, wake-phrase WAVs from `scratch/make-wake-wavs.ps1`) and is not committed.

## Status

Phase 1 of the split: files copied from Spidey Sense, new minimal shell. Not released yet.
