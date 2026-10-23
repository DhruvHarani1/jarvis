# Outlook, calendar and Teams: set up your own Jarvis app

Microsoft handles mail, calendar and Teams through one service called Microsoft Graph, and one app registration can cover both your personal Outlook account and your work account. Section 1 is the registration. Section 2 is what is different for a **work** account (Teams), where your employer's IT decides.

Honest limits up front:

- Your **personal Outlook.com / Hotmail** account: this works. Mail and calendar through Graph are supported for personal accounts.
- Your **work account**: the same app can sign in, but many companies block employees from allowing outside apps, or require an administrator to approve each one. If yours does, mail, calendar and Teams on the work account cannot be connected without IT. See section 2 for what to ask for, and for what Jarvis can do without any approval.
- **Teams chat for a personal account** does not exist through Graph; Teams is a work or school feature here.

## 1. Register the app (about 10 minutes, free)

1. Open <https://entra.microsoft.com/> and sign in with the Microsoft account you will own the app with.
   - Microsoft's documentation lists an Azure account as a prerequisite. A personal Microsoft account normally gets a "Default Directory" when it first signs in, which is enough. **If the portal says you have no directory or tenant**, create a free Azure account at <https://azure.microsoft.com/free> (it may ask for a card to verify identity; the free tier is not charged unless you start paid services) and come back. I could not test this from here, so tell me if you hit it.
2. Left menu: **Entra ID**, **App registrations**, **New registration**.
3. Name: `Jarvis`.
4. **Supported account types**: choose **Any Entra ID Tenant + Personal Microsoft accounts** (the last-but-one option). This lets both your personal and your work account sign in to the same app.
5. Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`. Jarvis picks a free port at sign-in time; Microsoft allows any port for `http://localhost` on desktop apps.
6. **Register**.
7. On the app's **Overview** page copy the **Application (client) ID**. There is no secret to create: a desktop app signs in with PKCE, not a secret.
8. Left menu **Authentication**, scroll to **Advanced settings**, **Allow public client flows**: **Yes**. Save.

## 2. Choose the permissions

Left menu **API permissions**, **Add a permission**, **Microsoft Graph**, **Delegated permissions**. Tick only what you want. Start small.

| Permission | What it allows | Notes |
|------------|----------------|-------|
| `User.Read` | Know who signed in | Already there |
| `offline_access` | Stay signed in without asking each time | Needed |
| `Mail.Read` | Read your mail | |
| `Mail.Send` | Send mail (Jarvis always asks you first) | Optional |
| `Calendars.Read` or `Calendars.ReadWrite` | Read, or read and edit, your calendar | Pick one |
| `Chat.Read` | Read your Teams chats | Work account only |
| `Chat.ReadWrite` | Send Teams chat messages (Jarvis always asks first) | Work account only |

Whether a work tenant lets you approve a permission yourself ("user consent") or needs an administrator ("admin consent") is a setting your IT controls, and it differs by permission and by company. The permission list in Microsoft's Graph documentation says which ones normally need an admin; check the current list there before asking IT.

## 3. If the work account refuses

At sign-in you may see "Need admin approval" or "Approval required". That is your company's policy, not a Jarvis problem, and I will not try to get around it. Options:

1. **Ask IT** to approve the app. Give them: the app name (Jarvis), the application (client) ID, the exact permissions from the table you ticked, and that it is a desktop app that you run on your own PC, with tokens stored locally and nothing sent to any server except Microsoft. A work policy may also forbid personal apps from reading company mail at all; accept that answer.
2. **Skip the API for work.** Jarvis can still open Teams and join meetings with deep links and the on-screen controls, and it can read your work notifications from the Windows notification inbox it already has (the text of those never goes to an AI model). It just cannot read or send chats itself.
3. **Connect only your personal accounts** (Outlook.com and Gmail).

Registering the app inside your employer's tenant needs a developer role there; that is a second reason to register it under your own account as in section 1.

## 4. Give it to Jarvis

In Jarvis's Accounts window (arriving in M2b): **Add Microsoft account**, paste the Application (client) ID, **Connect**. Your browser opens on Microsoft's own page:

1. Choose the personal or the work account.
2. Read the permissions, **Accept**.
3. Repeat **Add Microsoft account** for the second one; the same client ID works for both.

## Taking access away

- Personal: <https://account.live.com/consent/Manage>, pick **Jarvis**, **Remove these permissions**.
- Work: <https://myapps.microsoft.com/> or your account's "Apps you have allowed" page, or ask IT.
- To delete the app itself: Entra admin center, App registrations, Jarvis, **Delete**.

## Troubleshooting

| You see | Cause and fix |
|---------|---------------|
| `AADSTS50011` redirect URI mismatch | The redirect must be `http://localhost` under **Mobile and desktop applications**, not "Web". |
| `AADSTS700016` application not found | Wrong client ID, or the app was registered for the wrong account type. Check step 1.4. |
| `AADSTS65001` / "Need admin approval" | See section 3. |
| `AADSTS7000218` client assertion or secret required | **Allow public client flows** is still No (step 1.8). |
| Sign-in works for personal but not work (or the other way round) | The app must use **Any Entra ID Tenant + Personal Microsoft accounts** (step 1.4). It can be changed under **Authentication**. |
