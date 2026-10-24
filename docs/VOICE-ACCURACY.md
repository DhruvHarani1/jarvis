# Plan: a wake word that wakes, and speech that is heard correctly

Status: plan, partly started. Written 2026-10-24 after the first real-use report: "when I say Hey Jarvis it does not wake up, and my words are often captured wrong".

## 1. What is probably going wrong (hypotheses, not facts yet)

I have only tested with computer-made speech and a fake microphone, never with your voice on your microphone. So the first step is to measure, not to guess. The likely causes, most likely first:

| # | Cause | Why it fits | How to check |
|---|-------|-------------|--------------|
| 1 | **The wake word model is tuned for clear studio-style English.** Jarvis's keyword spotter (a tiny 3.3M-parameter model) was trained on a US-English corpus; an Indian-English accent, a laptop microphone and a few metres of distance all lower its confidence below the trigger threshold. | It fired on clean synthetic "Hey Jarvis", never tested on a real voice | Record 20 real "Hey Jarvis" samples and see how many trigger at the current threshold; sweep the threshold |
| 2 | **Windows' microphone clean-up is on** (echo cancellation, noise suppression, automatic gain). These are meant for calls and can chop the first syllable or squash quiet speech. | Jarvis asks for all three | Record the same phrase with them on and off and compare accuracy |
| 3 | **The speech model is small.** Moonshine "base" (about 60M parameters, English) is fast but not the most accurate; unusual accents and names suffer first. | "Always captures wrong words" | Word error rate (WER) against the same recordings for bigger models and for Groq Whisper |
| 4 | **Cut-offs in the pipeline:** end-of-speech detection that stops too early, the silence trimmer cutting a quiet start, linear resampling. | Short commands lose their first or last word | Listen to what is actually sent to the recogniser (Voice Lab saves it) |
| 5 | **Wrong microphone** is the Windows default (webcam, headset hub). | Common on laptops with several inputs | A microphone picker plus a level meter (the setup window has a meter already) |

## 2. Already done (this session)

- **Groq Whisper is the first choice again** when you have a Groq key (the "Most accurate" speech mode; tray: Speech recognition). Whisper large is far more accurate than any small on-PC model. Your audio for that turn goes to Groq; choose "Private" to keep it on this PC. If Groq is down or you are offline, the on-PC model answers.

## 3. Principle: measure, then change one thing at a time

A **Voice Lab** (issue: Voice Lab) records your own phrases once and keeps them as a private test set on your PC. Every later change (a different model, a different threshold, microphone settings) is then judged on the same recordings:

- **Speech:** 20 sentences you actually say to Jarvis (commands, names, WhatsApp, Spotify, numbers). Score = word error rate per engine.
- **Wake word:** 20 "Hey Jarvis" at normal volume, 10 quiet, 10 from 2 to 3 metres, plus 30 minutes of ordinary talk and TV to count false wake-ups.

Targets (acceptance): at least 95 of 100 spoken "Hey Jarvis" wake him, at most one false wake-up per hour of normal talk, and speech word error rate of 8 percent or less on your sentences.

## 4. Speech recognition options (best accuracy first)

| Option | Accuracy | Cost and catch | Verdict |
|--------|----------|----------------|---------|
| **Groq Whisper large-v3-turbo** (cloud) | Very good, handles accents well | Free tier you already have; audio leaves the PC for that turn | **Done: default when a key exists** |
| **Other free cloud recognisers** (Deepgram Nova, AssemblyAI) | Very good | Free credits, not a standing free tier (check current terms); another account and key; audio leaves the PC | Only if Groq is not enough; add behind the same setting |
| **Bigger on-PC model: NVIDIA Parakeet TDT 0.6B v2 (int8, about 460 MB) through sherpa-onnx** | Among the best English models, supports hotwords (boost "Jarvis", your contacts) | 460 MB download, a few hundred MB more RAM, slower than Moonshine on this PC | **Benchmark in Voice Lab; likely the best private option** |
| **Whisper small.en through sherpa-onnx** | Good | About 250 MB | Benchmark; a fallback if Parakeet is too heavy |
| Moonshine base (now) | Fair on accented speech | Small and fast | Keep as the light default only if Voice Lab shows it is good enough |
| Windows recogniser | Poor on free dictation | Built in | Last resort only |

Cheap accuracy gains that cost nothing in RAM:

- **Vocabulary hints:** a Whisper prompt with "Jarvis, WhatsApp, Spotify, Teams, Mum" and your saved contact names; hotwords for Parakeet.
- **Fuzzy command matching:** fast-path commands tolerate one or two wrong words ("open spotty fy" still opens Spotify, "volume thirty" vs "volume thirsty"), and Jarvis asks "Did you mean …?" when unsure instead of guessing or ignoring.
- **Show what he heard** ("I heard: …") in the window with a one-click retry, so mistakes are visible and fixable.
- **Capture settings:** try echo cancellation / noise suppression / automatic gain on and off; pick the microphone explicitly; capture at the device's native rate and resample properly.

## 5. Wake word options

| Option | Accuracy | Catch | Verdict |
|--------|----------|-------|---------|
| **Tune the current keyword spotter** (lower threshold, more spoken variants such as "hey jarvis", "ok jarvis", "jarvis", a longer boost) | Better recall, more false wake-ups | Free, quick | **Try first, with Voice Lab numbers** |
| **Two-stage wake:** the spotter triggers loosely, then the speech model listens to the last two seconds and confirms the word "Jarvis" (fuzzy) before waking | Keeps a loose, forgiving trigger without false wake-ups | A little CPU only when something triggers | **Try second** |
| **openWakeWord with its ready "hey jarvis" model** | Good in the field; trained on many synthetic voices | Pre-trained models are CC BY-NC-SA (fine for a free open-source project); needs a small audio-feature pipeline written in JavaScript on onnxruntime-node | Worth a spike |
| **Picovoice Porcupine** (it ships a built-in "Jarvis" keyword) | Very good, tiny, robust to accents and noise | Needs a free personal Picovoice AccessKey (an account) and its models are not open source; check their current free-tier terms | **Best quality for little work; offer as an optional engine** |
| **Wake by speech model:** run Moonshine on every spoken segment and look for "Jarvis" | Uses the better model | Constant CPU whenever anyone talks; more false wake-ups from the word "service" and the like | Fallback idea |
| **Push-to-talk** (Ctrl+Alt+Space, the mic button) | 100 percent | Not hands free | Always available |

## 6. Phases

| Phase | What | Needs from you | Done when |
|-------|------|----------------|-----------|
| **A. Measure** (about 1 session) | Voice Lab window: record the test set, A/B the capture settings, score Moonshine, Whisper (Groq) and any installed model, sweep the wake threshold; saves everything locally | About 15 minutes of speaking; your Groq key (you have it) | You can see numbers instead of guesses |
| **B. Quick fixes** (about 1 session) | Apply what A shows: capture settings, thresholds, vocabulary hints, fuzzy commands, "I heard:" line | Retest | Wake hit rate and WER move toward the targets |
| **C. Better engines** (1 to 2 sessions) | Parakeet (private) and a wake engine bake-off: tuned spotter, two-stage, openWakeWord, Porcupine; add the winner as a selectable engine | Optionally a free Picovoice AccessKey | Targets in section 3 met on your recordings |
| **D. Polish** | Microphone picker, level meter in the tray, voice barge-in, a "voice health" page | Feedback | No daily annoyance |

Everything keeps working while this is under way: push-to-talk, typed commands and the Windows fallbacks are untouched.

## 7. Questions only you can answer

1. Which microphone: laptop, headset, USB? How far away do you usually sit?
2. Are you fine with Groq hearing your voice when the key exists? (It is the default now; "Private" switches it off.)
3. Would you create a free Picovoice account for a better wake word, or do you want to stay fully free and open?
4. Which languages besides English, and when?
