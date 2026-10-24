# Jarvis

A voice-first AI assistant for Windows. Say "Hey Jarvis", ask or command, hear a natural voice answer. He can open apps, control volume and music, set timers and reminders, read and send your mail, manage your calendar, message people on WhatsApp and Teams, remember things about you, and read your notifications aloud. Free, open source, and private by default: speech recognition, the wake word and the voice run on your own PC.

> Status: version 0.3.2 (early, unsigned). Built by one developer with Claude. See [PLAN.md](PLAN.md) for the design and what is done, and [RESEARCH.md](RESEARCH.md) for why.

## Quick start

From source (needs Node.js 24 or newer):

```
npm install
npm start
```

Jarvis is one window: a glowing orb that shows what he is doing, a caption, and a conversation drawer. The gear opens Settings inside the same window (General, Voice, AI brain, Accounts, Tools, Memory, Activity, Setup). A setup page opens the first time. It checks your microphone, offers the voice models (about 130 MB, each file checked before use), and points you to the AI key and account steps. Everything in it is optional and can be done later from Settings.

To build an installer: `npm run dist` (writes `release\Jarvis-Setup-<version>.exe`).

## What you can say

| Say | What happens |
|-----|--------------|
| "Open Spotify", "open Teams", "open YouTube" | opens the app or site |
| "Volume 30", "mute", "louder", "next song", "pause" | system sound and media keys |
| "What's playing", "play despacito on Spotify", "play my liked songs" | Spotify (free accounts: links and search, you press play) |
| "Set a timer for five minutes", "remind me in an hour to call Mum" | timers and reminders |
| "Check my email", "what's on my calendar tomorrow", "add a dentist visit Friday at 4" | Gmail and Google Calendar (your own sign-in) |
| "Send a WhatsApp to Mum saying I'm late", "message Rahul on Teams saying…" | opens the chat with your text typed in, asks you first, then sends |
| "Join my next meeting", "what did Mum say" | meeting link from your calendar; notifications |
| "Remember my sister is called Asha", "what do you remember", "forget that" | local memory |
| "Good morning", "what does my day look like" | a spoken briefing: calendar, unread mail, reminders, notifications (made on your PC, no AI provider involved; also given once each morning) |
| "What is on my screen", "what does this error say" (off until you switch it on) | sends a screenshot to your AI provider after you click Allow |
| "Undo that" | undoes the last action where possible |
| "Run powershell Get-Date" (Power mode only) | runs a command, after you read it and click Allow |
| anything else | goes to the AI model, which can use the same tools |

Everyday commands work with no AI key and no internet.

## Privacy and safety

- **Microphone:** only open while the blue ring shows, or, if you turn the wake word on, for the phrase "Hey Jarvis" only, analysed on this PC and never stored.
- **Nothing is sent anywhere** unless you add an AI key (what you say, plus a short status line and any notes you asked him to keep, goes to that provider), sign in to Google (calls go straight to Google), or use WhatsApp/Teams (through the apps themselves).
- **Keys and sign-ins are encrypted** with Windows (DPAPI) and stay on this PC. Memory and contacts are a local database.
- **Risky actions always ask first**, showing exactly what will happen (the file, the recipient and the whole message). Deletes go to the Recycle Bin. File tools only reach Desktop, Documents, Downloads, Pictures, Music and Videos.
- **Text written by other people cannot give orders.** After Jarvis reads an email, the clipboard or a file name, a spoken "yes" no longer approves a risky action; only a click does. Facts stored while untrusted text was around are never fed back into prompts on their own.
- **Power mode** (Settings → Tools, off at every start) lets him run PowerShell commands, type into other apps and press buttons in them. Each call shows the exact command and needs a click on Allow (a spoken yes is never enough), runs as you and never as administrator, and a block list refuses the worst accidents (wiping disks, switching off Defender, reading his own stored keys). The block list is a safety net, not a wall: you reading the command is the real control.
- **Everything he does is logged** (tray: "Activity log…"). "Forget everything" erases memory, contacts and the saved conversation.

## Setting up

- AI keys: [docs/setup/free-keys.md](docs/setup/free-keys.md) (Groq is enough to start; Cerebras is a good second key)
- Google mail and calendar: [docs/setup/google-mail-calendar.md](docs/setup/google-mail-calendar.md)
- Microsoft (Outlook, work calendar, Teams): [docs/setup/microsoft-mail-calendar-teams.md](docs/setup/microsoft-mail-calendar-teams.md) (the sign-in itself is not built yet)
- FreeLLMAPI as an optional provider: [docs/setup/freellmapi.md](docs/setup/freellmapi.md)

## Develop

```
npm run test:unit          # 31 fast suites: no microphone, no network
npm run e2e                # drives the real app (fake microphone, fake AI provider, stand-ins for Google and PowerShell)
node scripts/e2e-welcome.js
node scripts/smoke-packaged.js   # after building: starts the packaged app and checks voice and speech recognition inside it
node scripts/license-audit.js    # production dependencies must be permissive
node scripts/measure-ram.js      # memory of the whole process tree
```

Layout: `main.js` (window, tray, wiring) · `audio/` (speech worker: Parakeet and Moonshine speech models, Piper voice, wake word) · `tools/` (the tool runtime, Windows tools, Spotify, Google, WhatsApp/Teams, memory) · `accounts/` (OAuth, Google) · `memory/` (SQLite) · `router/` (quota ledger, retry hints, health) · `brain.js` (providers and failover) · `agent.js` (tool-calling loop) · `fastpath.js` (commands that need no AI) · `renderer/` (the one window: orb and settings pages).

Test fixtures (`scratch/`) and downloaded models (`models-dev/`) are not committed.

## Contributing

Issues are the to-do list ([open issues](https://github.com/DhruvHarani1/jarvis/issues): look for *good first issue* and *help wanted*). [CONTRIBUTING.md](CONTRIBUTING.md) has how to run and test it and the safety rules every change must keep. The current top problem, a wake word that wakes and speech that is heard correctly, has its own plan: [docs/VOICE-ACCURACY.md](docs/VOICE-ACCURACY.md). Security problems: [SECURITY.md](SECURITY.md).

## Licences

Jarvis is MIT licensed ([LICENSE](LICENSE)). Third-party software and the ideas taken from FreeLLMAPI are listed in [NOTICE](NOTICE). Voice models are downloaded on demand and keep their own licences, shown before download. The Piper voice needs a GPL-3.0 phonemizer, which is downloaded as a separate optional component and is never part of the installer.
