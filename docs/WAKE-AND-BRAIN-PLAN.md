# Plan: "Hey Jarvis" that works, and a brain that is worth talking to

Written 2026-10-24 after the owner reported: the wake word never fires on their voice, conversation answers are weak and not "Jarvis", and Groq alone is not smart enough.

## What we know

- The shipped wake word is a 3.3 M-parameter keyword spotter trained on US English. It passed synthetic (computer-made) tests but has never been measured on the owner's real voice and, in daily use, it does not fire. The owner's microphone is a laptop array (Intel Smart Sound) with automatic gain on; the room noise already sits at about 1.3% level.
- No real-voice data exists, so tuning thresholds again is guessing. A different method is needed, plus a way to *see* what the microphone is hearing.
- "Whisper Flow" is a paid dictation app, not a service Jarvis can call. The honest equivalents are the speech models Jarvis already has on the PC (Moonshine, NVIDIA Parakeet) and Groq Whisper online.

## Wake plan (execute in this order)

1. **W1 Smart wake ("ears")**: always listen with a cheap voice-activity detector; when someone speaks, transcribe that utterance with the speech model on this PC (Moonshine, about 0.15 s for a short phrase) and look for "Jarvis" in the first words with a forgiving match (jervis, jarvas, garvis, "hey service" only after a greeting, and so on). Runs *in addition to* the keyword spotter; either one wakes him. If the sentence goes on ("Hey Jarvis, what is the time"), the rest of it is used as the command at once, so there is no second "listening" step to miss.
2. **W2 Show what he hears**: a faint line on the orb screen and a live list on Settings → Voice with the last things the microphone picked up ("heard: hey jarvis what time is it"). Wrong words become visible, so problems are diagnosable by the owner, not guessed by us.
3. **W3 Wake mode switch**: Settings → Voice: "Smart (recommended, uses about 300 MB more memory while listening)" or "Light (keyword spotter only)".
4. **W4 Push to talk stays** (Ctrl+Alt+Space) as the sure fallback.

Tests: matcher table test (many spellings and look-alikes), VAD segmentation test on synthetic audio, an end-to-end test where the fake microphone plays "Hey Jarvis, what is my CPU" and the command arrives with no extra step.

## Brain plan

1. **B1 Persona and depth**: rewrite the system prompt so Jarvis is capable and substantive (explains, reasons, helps with writing/maths/code in plain speech), calm, dry-witted, calls the user by name, and still never invents facts. Allow longer answers when the question needs it (the screen shows the full text, speech reads the first sentences if very long); larger token budget.
2. **B2 Smartest model first** (done in 0.3.2): ranking by model quality, many strong free providers, lower temperature.
3. **B3 FreeLLMAPI**: detect a running FreeLLMAPI on this PC and offer to connect it in one click; clear explanation that it pools provider keys the owner adds there (it does not create free quota by itself).
4. **B4 Quality check**: with the owner's keys a small fixed question set (facts, arithmetic, reasoning, "what do you not know") to compare providers and show which key answers best. (Needs the owner's keys; run from the app, not by us.)

## Not promised

AGI, or ChatGPT-level answers from small free models. Quality depends on the keys added; the plan removes our own mistakes (small model first, tiny answers, weak wake).

## Status (2026-10-24, version 0.4.0)
- W1 done: `wake-match.js` + `wake-asr.js`, wired next to the keyword spotter (`wakeMode` smart/light, default smart). Command after the name is used directly.
- W2 done: faint "heard" line on the orb screen, live list in Settings → Voice.
- W3 done: mode switch in Settings → Voice. W4: push-to-talk unchanged.
- B1 done: new persona and answer depth, token budgets raised (chat 700, tools 800).
- B2 done (0.3.2). B3 done: "Look for FreeLLMAPI on this PC" (ports 3001 and 31415), connects as one more provider.
- B4 not done (needs the owner's keys).
Tested with synthetic and fake-microphone audio only. The first real-voice evidence will be the owner's "heard" line: if it shows the wrong words, that is the next thing to fix (microphone, then model).
