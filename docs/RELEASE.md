# Release checklist

Nothing is published until the owner says so. This list is what "ready" means.

## Automated (run on the release machine)

```
npm run test:unit
npm run e2e
node scripts/e2e-welcome.js
node scripts/license-audit.js
npm run dist
node scripts/smoke-packaged.js     # needs the unpacked build: npx electron-builder --win --dir "-c.electronDist=node_modules/electron/dist" "-c.electronVersion=44.7.2"
node scripts/measure-ram.js
```

Close every running Jarvis and every leftover `electron.exe` first: stray test windows hold ports and make runs hang.

## By hand, on a clean Windows user or VM

1. **Install** `release\Jarvis-Setup-<version>.exe`. The installer asks for a folder, makes shortcuts, and starts Jarvis. SmartScreen will warn that the publisher is unknown because the installer is not code-signed; that is expected until a certificate is bought.
2. **First run:** the setup window appears. Microphone test says "I can hear you". "Download voice models" shows names, sizes, sources and licences, then installs. Closing the window counts as seen; the tray's "Setup guide…" reopens it.
3. **No keys, no internet:** "open Notepad", "volume 30", "set a timer for one minute" work. Typing a question says how to add a key.
4. **With a Groq key:** a spoken question gets a spoken answer; first word in about 1.5 s. Disconnect the network: Jarvis says so, simple commands still work.
5. **Permission denied path:** turn the microphone off in Windows privacy settings; Jarvis explains where to switch it on.
6. **Wake word:** turn it on, say "Hey Jarvis" three times from a normal distance (about 9 of 10 should wake him), then leave a TV or video on for 30 minutes (at most one false wake-up).
7. **Risky action:** "delete the file X" shows the exact path; DENY keeps it; ALLOW sends it to the Recycle Bin; "undo that" restores it.
8. **Mail and calendar** (with the owner's own Google app): connect, "check my email", "what's on my calendar", then a test send to yourself.
9. **WhatsApp:** save a contact, send to a friend who knows it is a test.
10. **Upgrade:** install the next version over this one. Settings, keys, accounts, memory and models must all survive. The in-app update check must find a newer release (needs the GitHub release to exist).
11. **Uninstall:** the app disappears, the "launch at startup" entry is removed, and the data folder is left alone (it holds the user's keys and memory).

## Before publishing

- `git status` is clean and the version in `package.json` is bumped.
- `NOTICE` and the README are current; no key, token or personal file is in the repository (`git grep -i -E "gsk_|AIza|sk-|GOCSPX"` finds nothing real).
- The GPL phonemizer is not in `release\win-unpacked` (it must be downloaded separately by the user).
- Create the GitHub release and upload the installer, its `.blockmap` and `latest.yml` (the auto-updater reads them).
- Say what the installer is and is not: free, unsigned, Windows 10/11 only, early.

## Known limits at 0.1.0

- Memory use is higher than the plan's budget (see PLAN.md, M1 and M5 results).
- Microsoft account sign-in and Teams call controls are not built.
- Spotify on a free account opens search for a name instead of playing it.
- The installer is not code-signed.
