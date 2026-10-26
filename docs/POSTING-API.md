# Morning Deck posting API (Trip Desk, Scheduler, Financial Expert, Security Expert)

Post a question card into Derek's morning deck; read his decision later. **A swipe only records a decision.**
Morning Deck never sends, buys, books, submits or deletes anything; your bot decides what to do with the answer.

- Endpoint: `http://127.0.0.1:8787` (box-local only). Never call the public URL with the token.
- Auth: `Authorization: Bearer $MD_TOKEN`. Read it by name each time and never print, log or copy the value:

```bash
MD_TOKEN=$(sed -n 's/^MD_TOKEN=//p' /workspace/morning-deck/.env)
```

## Fields (POST /api/cards)

| Field | Required | Rules |
|---|---|---|
| `id` | strongly recommended | stable id, `[A-Za-z0-9._:-]`; re-posting the same id is a no-op (returned in `duplicates`) |
| `source` | yes | your bot's display name, 1-60 chars (`Trip Desk`, `Scheduler`, `Financial Expert`, `Security Expert`) |
| `question` (or `title`) | yes | the question, 1-200 chars |
| `context` (or `body`) | no | short context, up to 4000 chars; `details` up to 20000 |
| `dueAt` | no | ISO-8601 date-time with offset or `Z`, e.g. `2026-10-26T17:00:00-04:00`. Overdue and due-today (ET) cards rank first |
| `expiresAt` | no | ISO-8601; the card disappears after it |
| `type` | no | `question` (default), `choice`, `info` (FYI, right = "Got it") |
| `priority` | no | `high`, `normal` (default), `low` |
| `gestures` | no | per-gesture overrides for `right`, `left`, `up`, `down`, `tap3`: `{ "label": "1-24 chars", "value": "..." }` |
| `replyTo` | no | object (<2 KB); `replyTo.agentId` must be a 1-120 char id string if present |

`question`/`context` are aliases for `title`/`body`. Invalid cards return `400` with an `invalid` list; nothing in the batch is stored.
You can post one card, an array, or `{ "cards": [...] }` (1-500).

**Status codes:** `POST /api/cards` returns `201 Created` when at least one card in the request was newly added, and `200 OK` when every card was a dedupe duplicate (an `id` already in the deck), so nothing new was stored. The body is `{ "added": [...], "duplicates": [...] }` either way.

## Examples

Trip Desk, due today, custom labels:

```bash
curl -s http://127.0.0.1:8787/api/cards \
  -H "Authorization: Bearer $MD_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "id": "trip-desk-hotel-hold-2026-10-26",
    "source": "Trip Desk", "emoji": "🧳",
    "question": "Keep the hotel hold for Tuesday?",
    "context": "The hold releases at 5 PM ET. Answering only records your choice; Trip Desk acts on it.",
    "dueAt": "2026-10-26T17:00:00-04:00",
    "gestures": { "right": { "label": "Keep hold", "value": "keep" }, "left": { "label": "Release", "value": "release" } },
    "replyTo": { "agentId": "trip-desk" }
  }'
```

Scheduler:

```bash
curl -s http://127.0.0.1:8787/api/cards -H "Authorization: Bearer $MD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"scheduler-sync-move-2026-10-27","source":"Scheduler","question":"Move Tuesday sync to 2 PM?","context":"Two attendees asked.","dueAt":"2026-10-27T09:00:00-04:00","replyTo":{"agentId":"scheduler"}}'
```

Financial Expert (no amounts or account numbers on the card):

```bash
curl -s http://127.0.0.1:8787/api/cards -H "Authorization: Bearer $MD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"finexp-review-2026-10-25","source":"Financial Expert","type":"choice","question":"Review this week'"'"'s budget summary now or later?","gestures":{"right":{"label":"Now"},"left":{"label":"Next week"}},"replyTo":{"agentId":"financial-expert"}}'
```

Security Expert, FYI:

```bash
curl -s http://127.0.0.1:8787/api/cards -H "Authorization: Bearer $MD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"secexp-fyi-2026-10-25","source":"Security Expert","type":"info","question":"FYI: weekly sign-in review is clean","replyTo":{"agentId":"security-expert"}}'
```

Success: `201 {"added":[...],"duplicates":[]}`. Same id again: `duplicates` lists it.

## Read the answer

```bash
curl -s "http://127.0.0.1:8787/api/answers?source=Trip%20Desk&since=2026-10-25T00:00:00Z" -H "Authorization: Bearer $MD_TOKEN"
```

Each answer has `cardId`, `gesture`, `label`, `value`, optional `text`, and `answeredAt`. `up` = snoozed (card comes back later).
More (sources, `?cardId=`, push delivery): `docs/BOT-API.md`.
