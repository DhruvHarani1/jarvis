# Gmail and Google Calendar: set up your own Jarvis app

About 15 minutes. Free. No credit card. You do this once; it works for every Google account you sign in with.

Google renames its menus now and then (the consent screen area is called "Google Auth Platform" at the moment). If a menu below is not where I say, use the search box at the top of the console.

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in with the Google account you want to own the app (any of yours; it does not have to be the Gmail you will read).
2. Accept the terms if asked. Skip any offer of a free trial or billing; you do not need billing.
3. Top bar, project picker, **New project**. Name: `Jarvis`. Create, then make sure `Jarvis` is the selected project.

## 2. Turn on the two APIs

1. Menu, **APIs & Services**, **Library**.
2. Search **Gmail API**, open it, **Enable**.
3. Back to the Library, search **Google Calendar API**, **Enable**.

## 3. Set up the consent screen (what you will see when you sign in)

1. Menu, **APIs & Services**, **OAuth consent screen** (or **Google Auth Platform**, **Get started**).
2. App name: `Jarvis`. User support email: your email. Next.
3. Audience: **External**. (Internal only appears if you use a Google Workspace work account, and it would limit sign-in to that organisation.) Next.
4. Contact email: your email. Agree to the policy, **Create**.

## 4. Choose the permissions ("scopes")

Menu, **Data Access** (older layout: "Edit app", Scopes), **Add or remove scopes**. Tick only what you want Jarvis to be able to do. Start small; you can add more later.

| Scope to find | What it allows |
|---------------|----------------|
| `.../auth/gmail.readonly` | Read your mail |
| `.../auth/gmail.send` | Send mail (Jarvis always asks you first) |
| `.../auth/calendar.readonly` | Read your calendar |
| `.../auth/calendar.events` | Create and edit events (instead of the read-only one) |

If a scope does not show in the list, paste it into "Manually add scopes". Save.

## 5. Decide how long the sign-in should last (important)

An External app that stays in **Testing** makes Google expire its sign-in after **7 days** (Google's own documentation says a Testing, External project "is issued a refresh token expiring in 7 days"). You would have to sign in again every week. Two ways to handle it:

- **Recommended for personal use: publish the app.** Menu, **Audience**, **Publish app**, confirm. For an app only you use, this just removes the 7-day limit. Google has not reviewed your app, so at sign-in it shows "Google hasn't verified this app". That is expected, because you are the author. Unverified apps are limited to 100 users, which is irrelevant here.
- **Or stay in Testing:** Audience, **Test users**, **Add users**, add every Google address you will connect. Re-sign in once a week.

## 6. Create the sign-in ID

1. Menu, **Clients** (older layout: **Credentials**, **Create credentials**, **OAuth client ID**).
2. Application type: **Desktop app**. Name: `Jarvis desktop`. **Create**.
3. A box shows a **Client ID** (ends in `.apps.googleusercontent.com`) and a **Client secret**. Download the JSON or copy both into a note. For a desktop app Google does not treat the secret as confidential, but keep it private anyway.

## 7. Give it to Jarvis

In Jarvis's Accounts window (arriving in M2b): **Add Google account**, paste the Client ID (and secret), **Connect**. Your browser opens on Google's own page:

1. Choose your account.
2. If you see **Google hasn't verified this app**: click **Advanced**, then **Go to Jarvis (unsafe)**. This is your own app, so it is safe, but read the permissions list and untick anything you did not mean to give.
3. Tick the boxes (Google lets you grant only some) and **Continue**. The page says you can close it.

Jarvis checks which permissions you actually granted and only offers those tools.

## Taking access away

<https://myaccount.google.com/permissions>, pick **Jarvis**, **Delete all connections**. Jarvis cannot read your mail or calendar from that moment. To remove the app completely, delete the `Jarvis` project in the Cloud console.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| `redirect_uri_mismatch` | The client type must be **Desktop app**, not "Web application". Create a new Desktop client. |
| `access_denied` or "app is being tested" | Still in Testing: add your address under **Audience, Test users**, or publish the app. |
| Asked to sign in again after about a week | Still in Testing; publish the app (step 5). |
| `invalid_grant` | The sign-in was revoked, expired, or you created more than the allowed number of tokens. Connect again from Jarvis. |
| Gmail scope warns it is "restricted" | Normal for read-only mail access. It only matters for apps that ask for more than 100 users. |
