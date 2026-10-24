# Contributing to Jarvis

Thank you for helping. Jarvis is a voice assistant that can act on someone's PC, so the rules below are about keeping people safe first and then about making changes easy to review.

## Where to start

- Open issues are the to-do list: [issues](https://github.com/DhruvHarani1/jarvis/issues). Look for **good first issue** (small and self-contained) and **help wanted**.
- [PLAN.md](PLAN.md) explains the design and what is done; [docs/VOICE-ACCURACY.md](docs/VOICE-ACCURACY.md) is the plan for the current top problem (a wake word that wakes, speech that is heard correctly).
- Comment on an issue before you start a big one, so two people do not build the same thing.

## Run it

You need Windows 10/11 and Node.js 24 or newer.

```
git clone https://github.com/DhruvHarani1/jarvis.git
cd jarvis
npm install
npm start
```

The first run opens a setup window. Voice models are downloaded from inside the app (with a consent box); for development they are looked up in `models-dev/` too (git-ignored), so you can unpack them there.

## Test it

```
npm run test:unit      # fast suites: no microphone, no network, no real PC changes
npm run e2e            # drives the real app with a fake microphone, fake AI provider and stand-ins for Google and PowerShell
node scripts/screenshots.js   # screenshots of every window into scratch/shots (look at them when you change the UI)
```

A change is ready when `npm run test:unit` is green and you have added a test for the behaviour you changed or added. Tests inject their dependencies (fetch, clock, spawn, storage), so most code can be tested without any hardware; follow that style.

## The safety rules (please do not weaken these)

1. **Every action goes through `tools/runtime.js`.** A new thing Jarvis can do is a tool with a tier (T0 read, T1 reversible, T2 consequential and asks first, T3 Power mode only), a JSON schema for its arguments, and an undo if one is possible. Nothing is run from a string a model wrote.
2. **Text from other people is data, not instructions.** Anything that comes from mail, the clipboard, file names, web pages, notifications or a screenshot must be returned with `untrusted: true`, so a spoken "yes" no longer approves a risky action afterwards.
3. **Outbound and destructive actions show exactly what will happen** (recipient, the whole text, the file path) and wait for the user. Prefer a click over a voice "yes" when in doubt.
4. **No secrets in memory, logs, prompts or the repository.** Keys are encrypted with Windows DPAPI; the activity log redacts; the memory store refuses things that look like keys.
5. **Privacy by default:** nothing leaves the PC unless the user picked a cloud provider or signed in. If your change sends something somewhere new, say so in the pull request and in the README.
6. **Do not add dependencies lightly.** The installer ships only permissive licences (`node scripts/license-audit.js` must pass). GPL code must stay a separately downloaded optional component.

## Code style

Plain JavaScript (CommonJS), no build step, small modules with a comment at the top that says what the module is for and why. Match the surrounding code. Write comments for the reason, not the line. User-facing text is plain, short, spoken-friendly English.

## Pull requests

- One topic per pull request, with the tests.
- Say what you changed and how you checked it (for UI changes include a screenshot).
- Do not commit models, recordings, `scratch/`, installers or personal data.
- By contributing you agree that your work is released under the MIT licence of this project.

## Reporting a security problem

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
