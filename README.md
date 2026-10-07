# Morning Deck

**▶ [Try the demo](https://watsdr.github.io/morning-deck/)**: runs entirely in your browser on example cards, and nothing is saved.
Open it on your phone and swipe.

One deck of swipe cards each morning with every question your bots have for you: swipe right/left/up/down to answer,
triple-tap to reply with text or photos. Installable PWA (Android Chrome) + a tiny zero-dependency Node API with a JSON store.

> **Safety:** a gesture only **records** a decision in the answer log (`data/answers.json`).
> Nothing in this app sends messages, buys, submits, or calls any outside service.
> Your bots read their answers back with `GET /api/answers` and act on them on their own.

## Quickstart

1. **Install Node.js 18+.** That's the only requirement to run it (no `npm install`). The Playwright tests also need `npm install` and Google Chrome.
2. **Create your config:** `scripts/init-env.sh` writes `.env` (mode 600) with a random private `MD_TOKEN`, `MD_PORT=8787`, `MD_HOST=127.0.0.1`,
   and an empty `MD_GREETING_NAME` (set it to your name for "Good morning, <name>").
3. **Start it:** `scripts/start.sh`. The first start seeds a few SAMPLE cards so there's something to swipe; `node scripts/reset.js --empty` clears them.
   Open `http://127.0.0.1:8787/?token=<MD_TOKEN>` on the same machine. `scripts/stop.sh` stops it.
4. **Reach it from your phone** (any public URL still needs the token):
   * **Quick, temporary:** download [`cloudflared`](https://github.com/cloudflare/cloudflared/releases) to `bin/cloudflared` (`chmod +x`),
     then run `scripts/start.sh --tunnel` and `scripts/phone-url.sh --tunnel`. Open the printed link on your phone, then use Chrome menu →
     *Add to Home screen*. The URL changes whenever the tunnel restarts.
   * **Permanent:** use Tailscale Funnel (`scripts/start.sh --tailscale`) or a named Cloudflare tunnel. See [Permanent URL](#permanent-url-optional).
5. **Hook up your bots:** any script that can make HTTP calls can post cards and read answers:

   ```bash
   TOKEN=...                      # MD_TOKEN from .env
   BASE=http://127.0.0.1:8787     # or your public https URL

   # put a question in tomorrow's deck
   curl -s -X POST "$BASE/api/cards" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"id":"scheduler-move-dentist-2026-10-08","source":"Scheduler","emoji":"📅","title":"Move the dentist to Thu 4:15 PM?","body":"The office offered a new slot.","replyTo":{"bot":"scheduler","task":"t_1"}}'

   # read the answers back (filter by bot and time)
   curl -s "$BASE/api/answers?source=Scheduler&since=2026-10-08T00:00:00-04:00" -H "Authorization: Bearer $TOKEN"
   ```

   Each answer has `value` (e.g. `yes`/`no`/`skip`/`snooze`), optional `text` and photo `attachments`, and echoes your card's `replyTo`.
   See [Card intake format](#card-intake-format) and [API](#api).

## Installing on your phone

When Chrome says the app is installable, it fires `beforeinstallprompt`. The app keeps that event and shows an **Install app** pill
next to the cards-left badge; tapping it opens Chrome's install dialog. If the event doesn't arrive within about 4 s (in-app browsers,
already installed, Chrome's own rules), a smaller **Install** button opens a short help sheet: the Install icon in the address bar,
⋮ → *Install and create shortcut* / *Add to home screen*, or Share → *Add to home screen*. Inside another app's browser, choose ⋮ → *Open in Chrome* first.
Nothing is shown when the app already runs installed (`display-mode: standalone`). Each page load also sends a small diagnostics
beacon (`POST /api/diag`, UA + display/SW flags only) so you can see what the phone's Chrome reports in `logs/diag.log`.
New releases update themselves: the service worker skips waiting and claims the page, and the page reloads once it's idle.

## Use it with a Grok Bot

Morning Deck is a good inbox for a Grok Bot (or any assistant with a shell) and the other bots it works with:

1. The bot clones this repo on its machine and runs `scripts/init-env.sh` then `scripts/start.sh`. The server needs only Node 18+.
2. It exposes the server with a tunnel: `scripts/start.sh --tunnel` (Cloudflare quick tunnel) or Tailscale Funnel / a named tunnel for a
   permanent URL. Then it sends you the phone link from `scripts/phone-url.sh` once. After that first visit, your phone stays signed in.
3. Whenever any bot has a question for you, it `POST`s a card to `/api/cards` with the Bearer token. Each morning you swipe through the deck.
4. The bots poll `GET /api/answers?source=<bot>&since=<time>` and act on your answers themselves. Morning Deck only records them.

## Static demo (GitHub Pages)

`node scripts/build-pages.js` builds `docs/`, a server-less copy of the app for GitHub Pages (Settings → Pages → *main* / */docs*).
It's the same `public/app.js`. When the page is on `*.github.io`, sets `window.MD_STATIC_DEMO = true`, or is opened with `?demo=static`,
the app swaps its fetch layer for an in-browser mock API. The deck comes from `docs/demo-deck.json`: the generic samples from
`scripts/sample-cards.js` plus the built-in feedback card. Answers and undo live in memory only, photos are off, and the Demo banner shows.
All paths are relative, so it works under `/<repo>/`; the manifest and service worker are scoped to that subpath.
Re-run the build after changing `public/` and commit `docs/`. Check it with `node test/pages-demo.js <pages-url>`.

## Run

```bash
scripts/start.sh               # server only (nohup, pid in run/server.pid, log in logs/server.log)
scripts/start.sh --tailscale   # server + Tailscale Funnel: permanent https://<hostname>.<your-tailnet>.ts.net
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
A Tailscale Funnel URL never changes (see Permanent URL).

## Permanent URL (optional)

The token is still required on any public URL; without it every page is `401`.

**Tailscale Funnel** gives you `https://<hostname>.<your-tailnet>.ts.net`, no domain needed:

* If Tailscale is already installed system-wide, `tailscale funnel --bg 8787` is all you need.
* Otherwise `scripts/start.sh --tailscale` runs a private `tailscaled` from `bin/` in **userspace-networking** mode (no root/TUN/systemd).
  Put the static `tailscale` and `tailscaled` binaries from <https://pkgs.tailscale.com/stable/#static> into `bin/`.
  The first run asks you to log in: `bin/tailscale --socket=run/tailscale/tailscaled.sock up --hostname=morning-deck`, open the printed
  link, and enable HTTPS + Funnel for your tailnet when the admin console prompts. Then run `scripts/start.sh --tailscale` again.
  It publishes `127.0.0.1:$MD_PORT` with Funnel and writes the URL to `run/tailscale.url` (used by `scripts/phone-url.sh`).
* State (node key, certs, Funnel config) lives in `run/tailscale/`. Keep it. `scripts/stop.sh --tailscale` stops `tailscaled`; the config comes back on the next start.
* After a reboot, run `scripts/start.sh --tailscale` again (or wire it into systemd/cron `@reboot`).

**Named Cloudflare tunnel** (needs a domain on Cloudflare):
`cloudflared tunnel login`, `cloudflared tunnel create morning-deck`, `cloudflared tunnel route dns morning-deck deck.example.com`,
then `cloudflared tunnel run --url http://127.0.0.1:8787 morning-deck`.

## Auth

Everything except `/manifest.webmanifest`, `/icons/*`, and `/favicon.ico` (Chrome fetches those without cookies, and they hold no data) needs the token:

* **Phone / browser:** open `https://<host>/?token=<MD_TOKEN>` once. The server sets an httpOnly, SameSite=Lax cookie (Secure over HTTPS) that lasts a year, then redirects so the token is gone from the address bar. The installed PWA shares Chrome's cookies.
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

Env overrides: `DEMO_PORT` (8792), `DEMO_DIR`, `DEMO_NAME`.

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
    "path": "/path/to/morning-deck/data/uploads/upl_2ebbee308973a84a383b.webp" }
]
```

`path` is the absolute file path on this box, so bots running here can read the image directly. `url` is relative to the server and needs
the Bearer token (`curl -H "Authorization: Bearer $TOKEN" "$BASE/api/uploads/<id>" -o photo.webp`).

```bash
TOKEN=...   # from .env
BASE=http://127.0.0.1:8787   # or your public https URL

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
scripts/build-pages.js  builds docs/ (static GitHub Pages demo with the in-browser mock API)
docs/                   generated static demo site (don't edit by hand)
test/pages-demo.js      Playwright check of the static demo: 5 gestures, undo, feedback card last, cleared screen
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
