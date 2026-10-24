# Using FreeLLMAPI with Jarvis (optional)

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) (MIT licence) is a separate program that pools many providers' free tiers behind one local address. It is **not part of Jarvis** and you do not need it: Jarvis has its own small router built on the same ideas (see `NOTICE`). If you already run it, Jarvis can use it as one more provider.

## What it is and is not

- It does **not** create free tokens. The big number in its README ("7.4 billion tokens a month") is the sum of every provider's free tier, and you still need your own account and key at each provider. With only a Groq key it can only use Groq.
- It runs as its own program (its desktop app, or a Docker container). That costs memory on top of Jarvis; its README quotes about 40 MB for the server alone, and the desktop app brings a second Chromium.
- Its router decides which provider answers. The list includes many small gateway services whose terms and data handling nobody has checked. **Anything you say to Jarvis could be sent to one of them.** That is the main reason it is not the default.

## Setup

1. Install and start FreeLLMAPI yourself, add your provider keys in its dashboard, and copy its **unified API key** (it starts with `freellmapi-`).
2. In Jarvis's keys window choose **FreeLLMAPI (running on this PC)**. The address is filled in (`http://127.0.0.1:3001/v1`; the desktop build of FreeLLMAPI uses `http://127.0.0.1:31415/v1`, change it if yours differs). Paste the unified key and **Add key**.
3. Use the **Test** button on the key. Put the key where you want it in the list, or let Smart order place it.

Jarvis only talks to it over your own PC (`127.0.0.1`). Tool calling works through it if the provider it picked supports tools; otherwise Jarvis falls back to the next key.

## Advice

- Keep your own direct keys (Groq, Cerebras) **above** it in the list, so private questions go to providers you chose.
- If you care who sees your words, do not use it.
- Do not try to get around its paid "live catalog": it is not needed, and the free monthly catalog is enough for Jarvis.
