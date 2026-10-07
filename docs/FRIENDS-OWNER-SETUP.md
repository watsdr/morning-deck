# Morning Deck for Friends: one-time owner setup (Google + Microsoft sign-in)

Morning Deck for Friends (`https://watsdr.github.io/morning-deck/friends/`) runs entirely in each friend's browser.
Most services work with **no setup at all**: Weather, News & RSS, My reminders, Calendar link (ICS), Todoist, GitHub and the Universal inbox.

Google (Calendar, Gmail, Tasks) and Microsoft (Outlook mail and calendar, To Do) are different: each requires the app to be
**registered once** by whoever publishes it. Registering is free. It produces a **client ID**, which is a public identifier and
not a secret. Until an ID is in `friends/config.js`, those tiles show **Needs setup** and everything else keeps working.

You do this once, then paste the IDs into one file. You never handle anyone's data: friends sign in on Google's or Microsoft's
own pages, and their tokens stay in their own browser.

> Values used below
> * Site origin: `https://watsdr.github.io`
> * App URL: `https://watsdr.github.io/morning-deck/friends/`
> * Microsoft redirect page: `https://watsdr.github.io/morning-deck/friends/auth/ms-redirect.html`
> * Where the IDs go: `friends/config.js` → `googleClientId`, `microsoftClientId`

---

## 1. Google (Calendar, Gmail, Tasks): about 10 minutes

The app uses Google Identity Services' **token model** (a popup, no client secret, no server). Access tokens last one hour,
so friends tap “Refresh Google” once per session. That's expected for serverless apps.

1. **Create a project.** Go to <https://console.cloud.google.com/> → project picker → **New project** → name it `Morning Deck` → **Create**, then select it.
2. **Enable the APIs.** Go to **APIs & Services → Library** and enable each of these:
   * **Google Calendar API**
   * **Gmail API**
   * **Google Tasks API**
3. **Set up the consent screen.** Open **Google Auth Platform** (older consoles call it **APIs & Services → OAuth consent screen**) → **Get started**:
   * App name: `Morning Deck`. User support email: your address.
   * Audience: **External**.
   * Contact information: your address. Agree to the policy → **Create**.
   * Optional (**Branding**): app logo, home page `https://watsdr.github.io/morning-deck/friends/`, privacy policy link (the in-app privacy note is a good basis).
4. **Keep it in Testing mode and add your friends.** Open **Audience**:
   * Publishing status: leave it on **Testing**. Don't press “Publish app”: Gmail scopes are *restricted*, and publishing would mean Google verification plus a security assessment.
   * Under **Test users**, click **+ Add users** and enter each friend's Google account email. Up to 100 test users are allowed.
     **A friend who isn't on this list gets “Access blocked … has not completed the Google verification process”.**
   * Test users see a “Google hasn't verified this app” screen. They tap **Continue**; that's normal for Testing mode.
5. **Add the scopes.** Open **Data Access** → **Add or remove scopes** and add:
   * Read-only, used by default:
     * `https://www.googleapis.com/auth/calendar.readonly`
     * `https://www.googleapis.com/auth/gmail.readonly`
     * `https://www.googleapis.com/auth/tasks.readonly`
   * Requested only when a friend turns on **Let swipes act** for that service:
     * `https://www.googleapis.com/auth/calendar.events` (RSVP)
     * `https://www.googleapis.com/auth/gmail.modify` (archive / mark read, reversible; never send or delete)
     * `https://www.googleapis.com/auth/tasks` (complete / un-complete)
   * **Save**.
6. **Create the client ID.** Open **Clients** (or **APIs & Services → Credentials → Create credentials → OAuth client ID**):
   * Application type: **Web application**. Name: `Morning Deck for Friends`.
   * **Authorized JavaScript origins** → **+ Add URI** → `https://watsdr.github.io`. Enter exactly that: no path, no trailing slash.
     Optional, for local testing: `http://127.0.0.1:8796`.
   * **Authorized redirect URIs**: leave this empty. The token-model popup doesn't use one.
   * **Create**, then copy the **Client ID** (`1234567890-abc…apps.googleusercontent.com`).
     Ignore the client secret: a browser app must never contain it, and Morning Deck doesn't need it.
7. Paste the ID into `friends/config.js` (see [step 3](#3-paste-the-ids-and-publish)).

Origin changes can take a few minutes to apply on Google's side.

## 2. Microsoft (Outlook mail and calendar, To Do): about 10 minutes

The app uses MSAL.js 5 (authorization code + PKCE, popup) with Microsoft's redirect-bridge page. There's no client secret
and no server.

1. **Open Entra.** Go to <https://entra.microsoft.com/> → **Identity → Applications → App registrations** (in the Azure portal: **Microsoft Entra ID → App registrations**).
   You need a directory (tenant). A personal Microsoft account without one can create a free Azure account, which creates a directory.
   No paid services are used.
2. **Register the app.** Click **New registration**:
   * Name: `Morning Deck for Friends`.
   * **Supported account types: “Accounts in any organizational directory (Any Microsoft Entra ID tenant – Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)”**.
     That's “any account type”, so friends with Outlook.com, Hotmail, work or school accounts can all sign in.
   * **Redirect URI**: platform **Single-page application (SPA)** → `https://watsdr.github.io/morning-deck/friends/auth/ms-redirect.html`.
   * **Register**.
3. **Copy the ID.** On **Overview**, copy the **Application (client) ID** (a GUID).
4. **Check Authentication.** Under **Authentication**:
   * The SPA redirect URI above is listed. Optional for local testing: add `http://127.0.0.1:8796/morning-deck/friends/auth/ms-redirect.html` as another SPA URI.
   * Leave **Implicit grant** (access tokens / ID tokens) **unchecked**. MSAL uses the code flow with PKCE.
   * Don't create a client secret or certificate.
5. **Add API permissions.** Go to **API permissions** → **Add a permission → Microsoft Graph → Delegated permissions** and add:
   * Read-only, used by default: `User.Read` (already there), `Mail.Read`, `Calendars.Read`, `Tasks.Read`.
   * Only when a friend turns on **Let swipes act**: `Mail.ReadWrite` (mark read / archive, reversible), `Calendars.ReadWrite` (accept invites), `Tasks.ReadWrite` (complete tasks).
   * Admin consent isn't needed for personal accounts. Work or school tenants may require their admin's approval, and unverified
     multitenant apps can be blocked by a company's policy. That's the employer's setting, not something the app can change.
6. Paste the ID into `friends/config.js`.

## 3. Paste the IDs and publish

Edit `friends/config.js`, the only file to change:

```js
window.MD_FRIENDS_CONFIG = Object.assign({
  googleClientId: '1234567890-abc123.apps.googleusercontent.com',   // from step 1.6
  microsoftClientId: '00000000-1111-2222-3333-444444444444',        // from step 2.3
  ownerName: '',        // optional: shown on the feedback card ("share it with …"); empty = "the person who shared this app"
  feedbackEmail: '',    // optional public address for the "Email" feedback button; empty = the friend picks a recipient
  ...
```

Then rebuild and push:

```bash
node scripts/build-pages.js        # copies friends/ into docs/friends/ and bumps the service worker version
git add friends/config.js docs/
git commit -m "Friends: enable Google and Microsoft sign-in"
git push
```

GitHub Pages redeploys in about a minute. Friends' apps update themselves on their next open: the service worker picks up
the new version and reloads once the app is idle. The Google and Microsoft tiles change from **Needs setup** to **Sign in**.

## Checklist when a friend can't sign in

| Symptom | Fix |
| --- | --- |
| Google: “Access blocked … has not completed the Google verification process” | Add their Google email under **Audience → Test users**. |
| Google: `redirect_uri_mismatch` / `origin_mismatch` | The JavaScript origin must be exactly `https://watsdr.github.io`. |
| Google: works, then “Refresh Google” every hour | Expected. Token-model access tokens last 1 hour, and a serverless app can't refresh silently. |
| Microsoft: `AADSTS50011` redirect URI mismatch | The SPA redirect URI must be exactly `https://watsdr.github.io/morning-deck/friends/auth/ms-redirect.html`. |
| Microsoft: “Need admin approval” | The friend's work/school tenant blocks user consent. A personal account works; otherwise their admin must approve. |
| Popup closes immediately / blocked | Allow pop-ups for `watsdr.github.io`, or open the app in Chrome/Safari rather than an in-app browser. |

## What the owner can and can't see

Nothing. There's no server, no analytics and no logs on our side. Google and Microsoft show you, as the registrant, aggregate
sign-in counts in their consoles, never anyone's mail, calendar or tasks. Friends can revoke access any time at
<https://myaccount.google.com/permissions> or <https://account.live.com/consent/Manage> (personal) / <https://myapps.microsoft.com> (work).
