# More free AI keys for Jarvis

Jarvis can use several free AI providers at once. With more than one key, a busy or exhausted provider no longer makes him go quiet: he moves to the next one, and (with **Smart order** on) he tries the fastest, most reliable key first. You sign up and paste your own key; Jarvis never creates accounts for you.

Open the keys window with the brain button (the head icon) in Jarvis's top bar, pick the provider, paste the key, **Add key**.

## Which ones are worth it

The limits below are a snapshot from when I wrote this (October 2026) and free tiers change without notice. Jarvis also learns the real limits from each provider's "too many requests" answers, so a wrong number here cannot lock you out.

| Provider | Why | Typical free limits | Sign-up | Notes |
|----------|-----|---------------------|---------|-------|
| **Groq** (you have this) | Very fast first word; also does speech recognition if you want cloud speech | about 30 requests/min, about 1,000 requests/day | console.groq.com/keys | Best main key |
| **Cerebras** | Extremely fast, large daily token pool | about 30 requests/min | cloud.cerebras.ai | Best second key |
| **Google Gemini** | Strong, long memory of the conversation | about 10 requests/min, 250/day | aistudio.google.com/apikey | **The free tier may be used by Google to improve its models.** Jarvis shows a warning next to this key. |
| **OpenRouter** (`:free` models) | Many different free models | about 20 requests/min, 50/day (1,000/day after a one-time $10 top-up) | openrouter.ai/keys | Speed varies with the model |
| **Mistral** | Another independent provider | about 2 requests/min | console.mistral.ai/api-keys | Too slow for the main seat; fine as a background fallback. The free plan may ask for a phone number. |

For one person talking to Jarvis, a few hundred requests a day is plenty. **Requests per minute and per day are the limit that matters, not tokens.** Two or three keys (Groq, Cerebras, Gemini) already give you redundancy; more keys add resilience, not much more capacity.

## Privacy

Whatever you say to Jarvis, plus a short status line and any notes he is allowed to use, goes to the provider that answers. Jarvis never sends your notifications, files or mail to a provider unless you ask a question that needs them. Each key in the window shows a short privacy note; keys marked with a warning are on a plan where the provider may train on what you send. If that matters to you, leave that key off.

## What "used up for now" means

Each key row shows today's use ("today 12 of 1000 requests"). When a key runs out of its minute or its day, Jarvis skips it without wasting a request on it, and the answer line says when it comes back. Daily allowances reset at midnight **UTC** (5:30 in the morning in India).

## Not worth it

Jarvis does not offer providers that hand out "free" access by sharing other people's keys or by evading limits. Those break the providers' terms, they are unreliable, and your words would go to people nobody has vetted.
