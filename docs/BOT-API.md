# Morning Deck: posting cards from a bot

Any bot on this box can put a question in Derek's morning deck and read his answer later.
Everything goes through `http://127.0.0.1:8787` (localhost only). Never call the public URL with the token.

## Auth

Read the token by name from `/workspace/morning-deck/.env` each time (it gets rotated; don't copy it into your own files):

```bash
MD_TOKEN=$(sed -n 's/^MD_TOKEN=//p' /workspace/morning-deck/.env)
```

Send it as `Authorization: Bearer $MD_TOKEN`. `?token=` is not accepted on `/api/*`. Never print, log or paste the value.

## Post a card

```bash
MD_TOKEN=$(sed -n 's/^MD_TOKEN=//p' /workspace/morning-deck/.env)
curl -s http://127.0.0.1:8787/api/cards \
  -H "Authorization: Bearer $MD_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "id": "scheduler-dentist-move-2026-10-20",
    "source": "Scheduler", "sourceId": "bot-scheduler", "emoji": "📅", "color": "#6d7cff",
    "type": "choice", "priority": "high",
    "title": "Dentist moved: which slot works?",
    "body": "The office offered two new times next week.",
    "details": "Option A: Tue 8:30 AM\nOption B: Thu 4:15 PM",
    "expiresAt": "2026-10-22T00:00:00-04:00",
    "gestures": {
      "right": { "label": "Tue 8:30", "value": "slot_a" },
      "left":  { "label": "Thu 4:15", "value": "slot_b" },
      "down":  { "label": "Neither",  "value": "neither" },
      "tap3":  { "prompt": "Suggest another time or ask me something" }
    },
    "replyTo": { "bot": "scheduler", "agentId": "<your agent id>", "ownerBot": "Scheduler",
                 "writeBack": { "task": "t_8812" } }
  }'
```

Reply: `201 {"added":[ids],"duplicates":[]}`. Re-posting the same `id` is a no-op (listed in `duplicates`). 400 lists per-card errors.
You can send one card, an array, or `{"cards":[...]}` (max 500).

## Card schema (full JSON Schema: `card.schema.json`)

| field | required | notes |
|---|---|---|
| `source` | yes | bot display name (≤60). Shown on the card and in History |
| `title` | yes | ≤200 |
| `id` | recommended | stable `<bot>-<slug>-<date>`, `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; used for dedupe |
| `sourceId` | | bot id; `GET /api/answers?source=` matches it too |
| `type` | | `question` (default) · `choice` · `info` |
| `body` / `details` | | ≤4000 on the card / ≤20000 in the triple-tap sheet |
| `priority` | | `high` · `normal` · `low` |
| `createdAt` / `expiresAt` | | ISO-8601; expired cards drop out of the deck |
| `emoji`, `color` | | avatar and accent (`#RGB` / `#RRGGBB`) |
| `gestures` | | per-direction overrides, see below |
| `replyTo` | | routing object (≤2000 chars JSON), echoed on every answer, see below |
| `sample` | | only for demo cards. Never set it on real cards, and never post made-up cards |

## Gestures

| gesture | question | choice | info | effect |
|---|---|---|---|---|
| swipe right | Yes `yes` | Approve `approve` | Got it `ack` | answered |
| swipe left | No `no` | Decline `decline` | Not useful `not_useful` | answered |
| swipe up | Later `snooze` | Later `snooze` | Later `snooze` | snoozed until the next 6:00 AM ET, then back in the deck |
| swipe down | Skip `skip` | Skip `skip` | Not mine `not_mine` | answered |
| triple-tap | Reply `reply` + text/photos | same | same | Derek types an answer, **or a question back to you** |

Override with `gestures.<right|left|up|down|tap3> = {label, value, prompt, snooze, disabled}`. A label without a value gets the
slugged label as value. An overridden `up` only snoozes if its value is `snooze` or it sets `snooze: true`.
A swipe only records the decision. Morning Deck never sends, buys or deletes anything; your bot acts on the answer, within
what Derek has already approved for it.

## replyTo: how the answer finds its way back

`replyTo` is opaque to Morning Deck. It's copied onto every answer for the card. Conventions the forwarding routine uses:

| key | meaning |
|---|---|
| `bot` | short bot name the routine forwards to (e.g. `scheduler`) |
| `agentId` | the exact agent that asked. If set, the answer goes to that agent, not just any agent of the bot |
| `ownerBot` | display name of the bot that owns the follow-up, if it isn't the poster |
| `writeBack` | anything your bot needs to resume (task id, thread id, file path). Returned untouched |

## How answers come back

1. **Pushed to you:** the routine "Forward Morning Deck answers to Chief of Staff" reads new answers every few minutes and
   forwards each one to `replyTo.agentId` (or `replyTo.bot`), with card id, title, gesture, value, typed text and photo paths.
2. **Pulled by you:** `GET /api/answers?source=<source or sourceId>&since=<ISO>` (or `?cardId=`), same Bearer header.

Answer entry: `{id, cardId, source, sourceId, cardTitle, gesture, label, value, text?, attachments?[].path, answeredAt,
recordedAt, replyTo, snoozedUntil?}`. Undone answers are hidden unless you pass `?all=1` (then they have `undone: true`).
A `tap3` answer with a question in `text` means Derek wants more info: answer it with a new card (new `id`).
A snoozed card comes back by itself; don't re-post it.
