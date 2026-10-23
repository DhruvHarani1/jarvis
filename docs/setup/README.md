# Connecting your accounts to Jarvis

Jarvis never asks for your password. For mail and calendar it uses each provider's official sign-in ("OAuth"): a browser window opens, you sign in on Google's or Microsoft's own page, and Jarvis only receives a token for the permissions you ticked. The token is stored encrypted with Windows (DPAPI) on this PC and nowhere else. You can revoke it at any time from your Google or Microsoft account page, and Jarvis stops working with that account immediately.

To do this Jarvis needs an "app registration" that belongs to **you** (a free ID that says "this is my Jarvis"). Nobody else's app is used, and nothing passes through a Jarvis server, because there is none. Each guide takes about 15 minutes, once.

| Account | Guide | Cost | Works with |
|---------|-------|------|------------|
| Gmail and Google Calendar | [google-mail-calendar.md](google-mail-calendar.md) | Free, no card | Any number of Google accounts |
| Outlook.com / Hotmail mail and calendar (personal) | [microsoft-mail-calendar-teams.md](microsoft-mail-calendar-teams.md) section 1 | Free; an Azure sign-up may ask for a card for identity checks (not charged) | Personal Microsoft accounts |
| Work Outlook, calendar and Teams | [microsoft-mail-calendar-teams.md](microsoft-mail-calendar-teams.md) section 2 | Free, but **your employer's IT policy decides** | Your work account, if your tenant allows it |
| Spotify | Nothing to set up | | Free account works through the app itself (links and media keys). Direct "play song X" needs Premium and a developer app, which Spotify now only gives Premium accounts |

## What Jarvis will ask for (and why), smallest first

| Permission | Lets Jarvis | Needed for |
|------------|-------------|------------|
| Read mail | "Do I have unread mail from Mum?", "read my latest email" | Reading |
| Send mail | "Reply that I will be late" (always shown to you and confirmed before sending) | Sending |
| Read calendar | "What is on my calendar today?" | Reading |
| Edit calendar events | "Add a dentist appointment on Friday at 4" (confirmed; can be undone by deleting the event) | Writing |
| Teams chat (work only) | Read recent chats, send a message (confirmed) | Teams |

You can start with the read-only permissions and add the others later. Jarvis asks for confirmation before anything leaves your PC (sending a mail, replying, inviting people), and never acts on instructions found inside an email.

## When it will be ready in the app

The sign-in screens and the mail and calendar tools are the next step in milestone M2b. These guides are written so the registration is done and waiting. When you finish a guide you will have **one Client ID** (Google also gives a Client Secret; Microsoft does not). Those are not passwords, but treat the secret like one: put it only into Jarvis's Accounts window when it exists, not in chat or in a file you share.
