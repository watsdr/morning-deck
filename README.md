# Morning Deck (v0)

One deck of swipe cards each morning with every question Derek's bots have for him.
Installable PWA (Android Chrome) + a tiny zero-dependency Node API with a JSON store.

> **Safety:** a gesture only **records** a decision in the answer log (`data/answers.json`).
> Nothing in this app sends messages, buys, submits, or calls any outside service.
> The bots read their answers back with `GET /api/answers` and act on them on their own.

## Run

```bash
scripts/start.sh               # server only (nohup, pid in run/server.pid, log in logs/server.log)
scripts/start.sh --tailscale   # server + Tailscale Funnel: permanent https://morning-deck.tail164b96.ts.net
scripts/start.sh --tunnel      # server + Cloudflare quick tunnel (https://<random>.trycloudflare.com); flags combine
scripts/phone-url.sh           # print the full private phone link (permanent Tailscale URL + token)
scripts/phone-url.sh --tunnel  # same, but with the current quick-tunnel URL
scripts/stop.sh                # stop server + quick tunnel (Tailscale stays up)
scripts/stop.sh --tailscale    # also stop tailscaled (Funnel config is kept and returns on next start)
node scripts/reset.js       # fresh SAMPLE deck (removes sample cards + their answers; real cards untouched)
node scripts/reset.js --all # wipe all cards + the whole answer log, then seed samples
node scripts/reset.js --empty # wipe everything, no samples
node test/isolated.js test/e2e.js         # Playwright touch test (5 gestures, undo, fling, feedback card) + screenshots/verify.json
node test/isolated.js test/e2e-photos.js  # photos on replies, offline queue, keyboard-safe sheet, feedback card, confetti -> verify-photos.json
                            # isolated.js = temp data dir + port 8799; the live data/ and :8787 are never touched
node test/installability.js [baseUrl]  # Chrome installability + offline check
node scripts/make-icons.js  # regenerate PNG icons from the SVG artwork
```

Config is in `.env` (created by `scripts/init-env.sh`, mode 600, git-ignored):
`MD_TOKEN` (private token), `MD_PORT` (8787), `MD_HOST` (127.0.0.1).
`MD_GREETING_NAME` (name in "Good morning, <name>"; empty = just "Good morning").
`MD_DATA_DIR` (or `DATA_DIR`) env var overrides the store location (default `./data`); tests use it to run a throwaway server.
`MD_ENV_FILE` points the server at a different env file (the demo uses its own, so it never reads the real token).

Quick-tunnel URLs change every time the tunnel restarts; run `scripts/phone-url.sh --tunnel` to get the new link.
The Tailscale Funnel URL never changes (see below).

## Tailscale Funnel (permanent URL)

Public URL: **https://morning-deck.tail164b96.ts.net** (Funnel on port 443 → `http://127.0.0.1:8787`, Let's Encrypt cert managed by tailscaled).
The token is still required; without it every page is `401`.

* Binaries: `bin/tailscale`, `bin/tailscaled` (official static build 1.102.5 from pkgs.tailscale.com; also symlinked into `/usr/local/bin`).
* `tailscaled` runs as the `box` user in **userspace-networking** mode (no root/TUN/systemd), detached with `setsid nohup`:
  ```bash
  D=/workspace/morning-deck
  setsid nohup $D/bin/tailscaled --tun=userspace-networking \
    --statedir=$D/run/tailscale --state=$D/run/tailscale/tailscaled.state \
    --socket=$D/run/tailscale/tailscaled.sock >> $D/logs/tailscaled.log 2>&1 < /dev/null &
  ```
  PID in `run/tailscaled.pid`. State (node key, TLS certs, serve/funnel config) is in `run/tailscale/` (mode 700). Don't delete it, or the node has to log in again.
* The CLI must be pointed at that socket: `alias ts='bin/tailscale --socket=run/tailscale/tailscaled.sock'`, then
  `ts status`, `ts funnel status`, `ts funnel --bg 8787` (idempotent), `ts funnel --https=443 off` (unpublish).
* `scripts/start.sh --tailscale` does all of this: starts tailscaled if it isn't running, checks it's logged in, re-runs `funnel --bg $MD_PORT`, and writes the URL to `run/tailscale.url` (read by `phone-url.sh`).
* First-time setup on a new box/state: `ts up --hostname=morning-deck` → open the printed `https://login.tailscale.com/a/...` link; Funnel + HTTPS must be enabled for the tailnet in the admin console (the CLI prints the link if they aren't).
* No container restart hook exists here, so after a box reboot run `scripts/start.sh --tailscale` again.

## Auth

Everything except `/manifest.webmanifest`, `/icons/*`, and `/favicon.ico` (Chrome fetches those without cookies, and they hold no data) needs the token:

* **Phone / browser:** open `https://<host>/?token=<MD_TOKEN>` once. The server sets an `HttpOnly; Secure; SameSite=Strict` cookie that lasts a year (Secure works on http://127.0.0.1 too, since browsers treat it as a secure context), then redirects so the token is gone from the address bar. `?token=` only works on pages; `/api/*` takes `Authorization: Bearer` (or the cookie). Strict withholds the cookie on a navigation that starts on another site (a link in chat or email), so that one locked response reloads itself once from the same origin, which does carry the cookie. Data dirs are 700 and data files 600. The installed PWA shares Chrome's cookies.
* **Bots:** `Authorization: Bearer <MD_TOKEN>`.

Logs redact `?token=`.

## Gestures (defaults, overridable per card)

| Gesture | question | choice | info (FYI) | Effect |
|---|---|---|---|---|
| swipe **right** | Yes → `yes` | Approve → `approve` | Got it → `ack` | card closed |
| swipe **left** | No → `no` | Decline → `decline` | Not useful → `not_useful` | card closed |
| swipe **up** | Later → `snooze` | Later → `snooze` | Later → `snooze` | card **snoozed until next 6:00 AM America/New_York**, then shows up again |
| swipe **down** | Skip → `skip` | Skip → `skip` | Not mine → `not_mine` | card closed |
| **triple-tap** | Reply → `reply` + text | same | same (prompt "Add a note for the bot") | opens details sheet; Save records `tap3` with the typed text |

Per-card `gestures.<dir>` overrides `label`, `value`, `prompt` (tap3), `snooze`, `disabled`.
If a card sets a label without a value, the value is the slugged label (`"Index fund"` → `index_fund`).
An overridden `up` snoozes only if its value is `"snooze"` or it sets `snooze: true`.

Desktop fallbacks: on-screen buttons, arrow keys, `Enter`/`r` = reply sheet, `u`/`Backspace`/`Ctrl+Z` = undo, `Esc` closes the sheet.
Undo marks the answer `undone: true`, appends a `{"gesture":"undo","undoes":"<answerId>"}` entry, and puts the card back as pending.

A gesture with `reply: true` (only the built-in feedback card's left swipe uses it) doesn't record on release: it opens the reply sheet in that
gesture's mode, and **Save** records that gesture (value + optional text/photos). Cancel records nothing.

## Photos on replies

The reply sheet (triple-tap or the **Reply** button) has an **Add photo** button: `<input type=file accept="image/*" multiple>`, so Android
offers both camera and gallery. You can add up to **6** photos. Each one is downscaled on the phone to at most **1600 px** on the long side,
saved as WebP (or JPEG if the browser can't encode WebP) at quality 0.85, and shown as a thumbnail with a remove × button. You can save a
reply with photos and no text.

On Save, each photo is POSTed to `/api/uploads`, then the answer goes to `/api/answers` with the upload ids. Retries are idempotent
(`X-Client-Upload-Id` and `clientAnswerId`). **Offline / server unreachable:** the whole reply, image blobs included, is queued in IndexedDB
(`morning-deck` → `outbox`). The status pill shows "waiting to sync", and the queue retries when the phone comes back online, when the app
regains focus, every 30 s, or when you tap the pill. If the server rejects a photo, or the reply can't be queued, the card comes back with the
sheet reopened and your text and photos still in it, plus an error toast. Photos are never dropped silently.

Keyboard: the viewport uses `interactive-widget=resizes-content`, and the sheet is also pinned to `visualViewport`
(`bottom = innerHeight - visualViewport.height - offsetTop`). When the keyboard is open, the context collapses and scrolls, and the
text box, photo button, and Save stay above the keyboard. The text box isn't auto-focused, so the keyboard only opens when you tap it.

## Built-in feedback card

At the end of every deck, the server adds **"How could Morning Deck be better?"** (source `Morning Deck`, 🌅, id
`morningdeck-feedback-YYYY-MM-DD` using the America/New_York date). It's always dealt **last**, whatever the priority of other cards,
and it shows up even when there are no other cards. Bots never post it. Its answered/snoozed state is kept in `data/builtin.json`, so
`cards.json` and `GET /api/cards` only ever contain bot cards. Once it's answered, skipped, or snoozed, it's gone until the next ET day,
when a new id starts fresh.

| Gesture | Label | value |
|---|---|---|
| right | Love it | `love_it` |
| left | Something's off | `something_off`. Opens the reply sheet first (text + photos optional) |
| down | Skip | `skip` |
| up | Later | `snooze` |
| triple-tap / Reply | Suggest | `suggestion` (text and/or photos) |

Its answers go into the same log with `source: "Morning Deck"`, `sourceId: "morning-deck"`, `replyTo: {"bot": "morning-deck"}`,
`builtin: true`. Read them with `GET /api/answers?source=Morning%20Deck`.

## Demo instance (shareable, no real data)

```bash
scripts/demo.sh start    # demo server on 127.0.0.1:8792 + its own Cloudflare quick tunnel (logs/demo-server.log, logs/demo-tunnel.log)
scripts/demo.sh url      # public demo URL (changes whenever the demo tunnel restarts)
scripts/demo.sh status
scripts/demo.sh stop     # stops only the demo server + demo tunnel
```

Same code, run with `MD_DEMO=1` as a separate process. It has its own data dir (`../morning-deck-demo-data`), its own env file and token
(`../morning-deck-demo-data/.env`, so the real `.env` is never read), its own port, and its own tunnel. The server refuses to start in demo
mode if it's pointed at `./data` or `./.env`. In demo mode:

* No token needed. A **Demo** banner is shown, and the greeting has no name unless you set `DEMO_NAME`.
* The SAMPLE deck (plus the built-in feedback card) is re-seeded at start and every hour.
* Answers, including feedback-card answers, are accepted but **never stored**. Every visitor and every reload gets a fresh deck, and undo
  only happens in the browser. `GET /api/answers` is always empty.
* Photos (`/api/uploads`) and card intake (`POST /api/cards`) are disabled (403).

Env overrides: `DEMO_PORT` (8792), `DEMO_DIR`, `DEMO_NAME`. Ports 8790/8791 are taken by a system service on this box.

## Card intake format

Full JSON Schema: [`card.schema.json`](card.schema.json). Required: `source`, `title`.

| field | type | notes |
|---|---|---|
| `id` | string `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` | stable id for dedupe, e.g. `scheduler-move-1on1-2026-10-07`. Assigned if missing. Re-posting an existing id is ignored and listed in `duplicates`. |
| `source` | string ≤60 | bot name (what `?source=` filters on) |
| `sourceId` | string | optional bot id (also matched by `?source=`) |
| `emoji`, `color` | string, `#RGB`/`#RRGGBB` | avatar + accent |
| `type` | `question` \| `choice` \| `info` | default `question` |
| `title` | string ≤200 | |
| `body` | string ≤4000 | shown on the card (about 6 lines) |
| `details` | string ≤20000 | shown in the triple-tap sheet (preview on question/info cards) |
| `priority` | `high` \| `normal` \| `low` | deck order: priority, then oldest `createdAt` first |
| `createdAt` / `expiresAt` | ISO-8601 | expired cards drop out of the deck |
| `sample` | bool | shows a SAMPLE ribbon |
| `tags` | string[] | optional |
| `gestures` | `{right,left,up,down,tap3: {label,value,prompt,snooze,disabled}}` | overrides |
| `replyTo` | object | opaque routing hint echoed back on every answer; Morning Deck never acts on it |

Example card:

```json
{
  "id": "scheduler-dentist-move-2026-10-08",
  "source": "Scheduler",
  "sourceId": "bot-scheduler",
  "emoji": "📅",
  "color": "#6d7cff",
  "type": "choice",
  "priority": "high",
  "title": "Dentist moved: which slot works?",
  "body": "The office offered two new times next week.",
  "details": "Option A: Tue 8:30 AM\nOption B: Thu 4:15 PM",
  "createdAt": "2026-10-08T06:30:00-04:00",
  "expiresAt": "2026-10-10T00:00:00-04:00",
  "gestures": {
    "right": { "label": "Tue 8:30", "value": "slot_a" },
    "left":  { "label": "Thu 4:15", "value": "slot_b" },
    "down":  { "label": "Neither", "value": "neither" },
    "tap3":  { "prompt": "Suggest another time" }
  },
  "replyTo": { "bot": "scheduler", "task": "t_8812" }
}
```

## Installing on your phone

When Chrome says the app is installable, it fires `beforeinstallprompt`. The app keeps that event and shows an **Install app** pill
next to the cards-left badge; tapping it opens Chrome's install dialog. If the event doesn't arrive within about 4 s (in-app browsers,
already installed, Chrome's own rules), a smaller **Install** button opens a short help sheet: the Install icon in the address bar,
⋮ → *Install and create shortcut* / *Add to home screen*, or Share → *Add to home screen*. Inside another app's browser, choose ⋮ → *Open in Chrome* first.
Nothing is shown when the app already runs installed (`display-mode: standalone`). Each page load also sends a small diagnostics
beacon (`POST /api/diag`, UA + display/SW flags only) so you can see what the phone's Chrome reports in `logs/diag.log`.
New releases update themselves: the service worker skips waiting and claims the page, and the page reloads once it's idle.

## API

| method | path | |
|---|---|---|
| GET | `/api/health` | `{ok, pending, total}` |
| POST | `/api/cards` | one card, an array, or `{cards:[...]}` (max 500). 400 with per-card errors if any card fails; otherwise `{added:[ids], duplicates:[ids]}` (201 if anything was added) |
| GET | `/api/cards` | every card with status (`pending`/`answered`/`snoozed`) |
| GET | `/api/deck` | pending cards (not answered, not snoozed into the future, not expired), sorted, with today's built-in feedback card always last |
| POST | `/api/answers` | `{cardId, gesture: right\|left\|up\|down\|tap3, value?, text?, attachments?, answeredAt?, clientAnswerId?}`. `value` defaults to the card's mapping; `tap3` needs `text` **or** `attachments`. `attachments` = up to 6 upload ids (strings or `{id}`) from `/api/uploads`. 409 if the card isn't pending. `clientAnswerId` makes retries idempotent. |
| POST | `/api/uploads` | one image: raw bytes (`Content-Type: image/*` or `application/octet-stream`), or JSON `{data: "<base64 or data: URL>", clientUploadId?}`. Max **8 MB**. The type comes from the file's magic bytes (jpeg/png/webp/gif/avif/heic; SVG and anything else get `415`). Optional `X-Client-Upload-Id` header makes retries return the same upload. Stores `data/uploads/<id>.<ext>` and returns `{id, url, mime, size, width, height, path}` (201, or 200 for a duplicate) |
| GET | `/api/uploads/<id>` | the image bytes (same auth as the rest of the API) |
| POST | `/api/answers/undo` | `{answerId}` (or `{cardId}` / `{}` = latest) |
| POST | `/api/diag` | install diagnostics from the app: `{ua, displayMode, bipFired, swControlled, standalone, ts, event}` → one JSON line in `logs/diag.log` (`MD_DIAG_LOG`), 204 |
| GET | `/api/answers` | answer log. `?since=ISO` (by `recordedAt`), `?source=<name or sourceId>`, `?cardId=`, `?all=1` to include undone answers + undo entries |

Answer entry: `{id, cardId, source, sourceId, cardTitle, cardType, sample, gesture, label, value, text?, attachments?, answeredAt, recordedAt, replyTo?, snoozedUntil?, builtin?}`.

`attachments` (only present when photos were added):

```json
"attachments": [
  { "id": "upl_2ebbee308973a84a383b", "url": "/api/uploads/upl_2ebbee308973a84a383b", "mime": "image/webp",
    "size": 17544, "width": 1600, "height": 1067,
    "path": "/workspace/morning-deck/data/uploads/upl_2ebbee308973a84a383b.webp" }
]
```

`path` is the absolute file path on this box, so bots running here can read the image directly. `url` is relative to the server and needs
the Bearer token (`curl -H "Authorization: Bearer $TOKEN" "$BASE/api/uploads/<id>" -o photo.webp`).

```bash
TOKEN=...   # from .env
BASE=http://127.0.0.1:8787   # or https://morning-deck.tail164b96.ts.net

curl -s -X POST "$BASE/api/cards" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"finance-card-autopay-2026-10-08","source":"Financial Expert","emoji":"💰","type":"question","priority":"normal","title":"Turn on autopay for the store card?","body":"Statement balance is due on the 15th."}'

curl -s "$BASE/api/answers?source=Financial%20Expert&since=2026-10-08T00:00:00-04:00" \
  -H "Authorization: Bearer $TOKEN"
```

## Files

```
server.js               plain node:http server (static app + API + token auth)
lib/core.js             storage (atomic tmp+fsync+rename JSON writes, in-process lock), validation, gesture defaults, 6 AM ET math, built-in feedback card
lib/uploads.js          image uploads: magic-byte type check, size limit, header width/height, atomic writes to data/uploads/
card.schema.json        intake JSON Schema
public/                 the PWA (index.html, styles.css, app.js, sw.js, manifest.webmanifest, icons/, fonts/ Plus Jakarta Sans OFL)
scripts/                start/stop/reset/init-env/phone-url, sample-cards.js, make-icons.js
scripts/demo.sh         public demo instance (MD_DEMO=1, own data dir/env/port/quick tunnel)
test/install.js         install flow check (real + simulated beforeinstallprompt, help sheet, /api/diag, SW auto-update)
test/isolated.js        runs a test against a throwaway server (temp MD_DATA_DIR, port 8799, seeded SAMPLE deck)
test/e2e.js             Playwright (system Chrome) touch-driven test, writes screenshots/ + verify.json
test/e2e-photos.js      photos, offline queue, keyboard (resized + overlay visualViewport), feedback card, confetti; verify-photos.json
test/installability.js  CDP installability + offline check
data/                   cards.json, answers.json, builtin.json (built-in card state), uploads/<id>.<ext> + <id>.json (git-ignored)
bin/cloudflared         quick-tunnel binary (git-ignored)
bin/tailscale(d)        Tailscale CLI + daemon for Funnel (git-ignored)
run/tailscale/          tailscaled state: node key, certs, funnel config (git-ignored, keep it)
```

## 2026-10-19 additions

* **Watchdog** (`scripts/funnel-watchdog.sh`, pid in `run/watchdog.pid`, log `logs/watchdog.log`): checks the public
  manifest without the token every 20 s; 200 and 401 are healthy. Restarts tailscaled when 4 of the last 8 checks failed or
  3 in a row, then re-runs `funnel --bg 8787` and re-adds `/hub-world -> 8796` if it's missing. 10-minute cooldown between
  restarts. Single instance (flock `run/watchdog.lock`); `--once` does one check into the same rolling window
  (`run/watchdog.window`); hung `--once` runs older than 2 min are killed. Also restarts `server.js` if localhost stops answering.
  Tunables: `WD_WINDOW`, `WD_FAILS_IN_WINDOW`, `WD_FAILS_IN_ROW`, `WD_COOLDOWN`, `WD_INTERVAL`.
* **Off-box backup mirror:** every save also writes the daily `cards-`/`answers-YYYY-MM-DD.json` to the persistent agent
  store `/cursor/stores/store-32b0f9fc-e45e-41a6-b51c-6bded31ff871/morning-deck-backups/` (outside `/workspace`), keeping 30
  days. On only for the live `./data`; `MD_BACKUP_MIRROR_DIR` overrides it (empty = off). The store is a FUSE mount that
  refuses chmod (files show 666); access is controlled by the store itself. The startup queue warning uses the newest backup
  in either place. Test: `node test/isolated.js test/backup-mirror.js --empty`.
* **Android app (TWA) carries no token** (since v1.1.0). It opens `https://morning-deck.tail164b96.ts.net/?source=twa` and uses
  Chrome's sign-in cookie, so open the private `?token=` link once in Chrome on the phone. Token rotations no longer need a new APK.
  Rebuild: `node ../morning-deck-android/gen.js`, then gradle `assembleRelease` + zipalign + apksigner with `run/android/morningdeck.keystore`.
* **Bots:** see [`docs/BOT-API.md`](docs/BOT-API.md) (card schema, gestures, `replyTo.agentId/ownerBot/writeBack`, answers).
* **Notify me (Web Push):** Settings (sliders icon in the header) → *Notify me* subscribes the device. VAPID keys are in `.env`
  (`scripts/init-vapid.sh`, mode 600); subscriptions in `data/push.json` (600). Uses the `web-push` npm package.
  `POST /api/notify` (Bearer only) sends "Your Morning Deck is ready: N cards" to every subscribed device if N (pending bot
  cards) > 0; otherwise `{sent:0, skipped:"nothing pending"}`. `?dryRun=1` shows the message without sending. Expired
  subscriptions (404/410) are dropped. Other routes: `GET /api/push/key`, `POST /api/push/subscribe {subscription}`,
  `POST /api/push/unsubscribe {endpoint}`, `GET /api/push/status`. The push goes through the browser's push service (FCM for
  Chrome); the payload only holds the count.
* **History:** Settings → *History* lists past answers (from `GET /api/answers?all=1`), newest first: card title, bot, choice,
  time in ET, reply text; undone answers are struck through and marked *Undone*.
* **Theme:** Settings → Theme (Dark default, Light). Stored per device in `localStorage`.
* **Reply = ask the bot:** the triple-tap sheet now reads "Reply or ask <bot> a question" so Derek can ask for more info.
* Tests: `test/features.js` (routing fields, push/notify, History, wording, theme), `test/screens.js` (390x844 screenshots to `run/screens-<date>/`).

## Off-disk backup and restore (Drive)

- `node scripts/backup-drive.js` stages a backup set in `run/backup-staging/<YYYY-MM-DD_HHMMSS>/`: `cards.json`,
  `answers.json`, `source.tar.gz` and `manifest.json` (sha256s, git commit, target folder). Local staging keeps the
  newest 14 sets. The tarball is git-tracked + untracked-not-ignored files minus `.env*`, `*.key`, `*.crt`, `*.pem`,
  keystores, token files, VAPID private keys, `*.bak*`, `data/ run/ logs/ bin/ node_modules/`; it is then scanned
  (entry names, live token/VAPID values, PEM private-key blocks) and the set is discarded if anything is found.
- Upload: a cron/node script on this box has no headless Google Drive credentials, so the upload is done by the agent
  with the Drive connector: each file goes into the private folder **by id** `1Klpu5Yni9GVRtt1aFjLkW0sZxrfJB-Z1`
  with its `driveTitle` from the manifest (`morning-deck_<set>_<file>`), then sets older than the newest 14 are trashed.
- Restore: download the newest set's four files into one folder (drop the `morning-deck_<set>_` prefix), then
  `scripts/restore.sh <that folder> [/workspace/morning-deck-restored]`. It verifies sha256s, clones
  `github.com/watsdr/morning-deck`, checks out the backed-up commit if it was pushed, overlays the tarball (exact
  source incl. unpushed work), runs `npm ci`, and installs the data files (600). It refuses a target that already has
  `data/`, never touches the live app, and never creates secrets: copy the old `.env` or run `scripts/init-env.sh` +
  `scripts/init-vapid.sh` (then re-pair phones with `scripts/pair-qr.sh`).

## QR sign-in

- On the box: open `http://127.0.0.1:8787/signin/qr` (box-only: loopback socket + loopback Host + no forwarding
  headers, and normal auth), or run `scripts/pair-qr.sh` to write `run/pair-qr.png` (600). Scan with the phone.
- The QR holds `https://morning-deck.tail164b96.ts.net/pair#<code>`; the code is in the fragment so it never reaches
  any server or proxy log. The code is single-use, expires after 5 minutes and is kept only as a sha256 in memory.
- `/pair` gives the phone a 180-day `md_session` (HttpOnly, Secure, SameSite=Strict) and burns the code.
  Attempts are rate-limited (10 per client / 40 overall per 15 min).

## Batch 2 (2026-10-22)
- **Due dates**: cards show a due line (`dueAt`, alias `due`; cards with only `expiresAt` show "Respond by"). `scripts/assemble.js`
  ranks anything due by end of today (ET) or overdue first, and sets `stale: true` on cards pending 7+ days (UI: "Still relevant?").
- **Morning push**: after a real run, assemble sends one count-only notification ("5 cards · 1 due today") to existing subscriptions;
  nothing at 0 cards. `--no-push` / `--dry-run` skip it. Same tag as `/api/notify`, so the two never stack.
- **Voice**: the card sheet has "Read aloud" (speechSynthesis) and "Answer by voice" (Web Speech API): yes/no/later/skip →
  right/left/up/down, always shown for confirmation; only "Record" saves the answer.
- **Weekly recap**: `GET /api/recap` (auth as /api/deck), computed on the fly; tile "Recap", Settings row, or `/?view=recap`.
- **App tiles**: Main Menu (`/main-menu/`) and Lantern Isle (`/hub-world/`) under the header.
- **Manifest shortcuts** (Deck, Recap, Main Menu) and the App Badging API (pending count). A real home-screen widget needs the
  Android project at /workspace/morning-deck-android.
- Tests: `node test/due-stale.js`, `node test/isolated.js test/assemble-push.js`, `node test/isolated.js test/screens-batch2.js --empty`.

## Staying signed in on the installed app
A signed-in phone stores a random device key in IndexedDB (only its sha256 hash is kept in `data/device-keys.json`).
If the cookie disappears (installed PWA or the private APK relaunching, a cache update), the app or the lock page
trades the key at `POST /signin/renew` for a fresh cookie, capped at the original 180-day session. Rotating the
token, or emptying `data/device-keys.json`, signs every device out. Keys are only issued to cookie sessions
(never Bearer), same-origin; renew failures share the sign-in rate limiter.

## Morning alert (Web Push)
VAPID keys live in the git-ignored `.env` (`scripts/init-vapid.sh`, private key never printed). Turn on
**Settings → Notify me** on the phone once. The 6:15 AM ET `scripts/assemble.js` run sends one count-only push when
at least one card is pending (none at 0 cards). Any other step can call `scripts/notify-ready.sh` (localhost,
Bearer from `.env`). Pushes go out from the box to the browser's push service (FCM for Chrome), not through the
Funnel; the Funnel only has to serve the HTTPS page where the phone subscribes.
