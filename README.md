# CompetitorPulse

CompetitorPulse tracks competitor product listings over time. It polls each tracked
competitor on a schedule, stores every snapshot, detects what changed, and asks an LLM to
explain the change in plain English ("Price dropped from $39/mo to $29/mo").

- **Backend:** Node.js 24, TypeScript, Fastify, PostgreSQL (Kysely + migrations)
- **Frontend:** React 19 + Vite
- **LLM:** any OpenAI-compatible Chat Completions API. Locally it uses the provided mock
  server, and the deployed instance uses a real provider (see [LLM](#llm)).
- **Live demo:** see [Deployment](#deployment)

## Quick start (Docker)

```bash
docker compose up --build
```

Then open http://localhost:3000, track `acme-crm`, open it, and click **Poll now** a few
times (or wait: competitors are polled every 30 s in this setup).

This starts Postgres, the mock LLM server and the app. The app applies migrations on start.

| Service  | URL                                               |
| -------- | ------------------------------------------------- |
| App      | http://localhost:3000                             |
| Mock LLM | http://localhost:4001 (`GET /control/stats` etc.) |
| Postgres | `postgres://postgres:postgres@localhost:5433`     |

To use a real model instead of the mock:

```bash
LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini docker compose up --build
```

## Local development

Requires Node.js 24 (`.nvmrc`) and Docker (for Postgres).

```bash
npm ci
docker compose up -d db mock-llm      # Postgres on :5433, mock LLM on :4001
cp .env.example .env
npm run migrate
npm run dev                           # API + workers on http://localhost:3000
npm run dev:web                       # React dev server on http://localhost:5173 (proxies /api)
```

Checks:

```bash
npm test             # server (unit + integration against Postgres) and web tests
npm run typecheck
npm run lint
npm run build
```

The server integration tests use the `competitorpulse_test` database that docker compose
creates, or the database in `TEST_DATABASE_URL`.

## API

The required contract:

```
GET    /api/competitors                  -> 200 [{ "id": string }, ...]
POST   /api/competitors    { "id" }      -> 201 Created
DELETE /api/competitors/:id              -> 204 No Content
GET    /api/competitors/:id/snapshots    -> 200 [Snapshot, ...]   newest first
```

```jsonc
// Snapshot
{
  "fetchedAt": "2026-09-10T12:00:00.000Z",
  "title": "Acme CRM",
  "tagline": "Simple CRM for small teams",
  "price": "$29/mo",
  "description": "Track leads and deals in one place.",
  "changed": true,
  "summary": "Price dropped from $39/mo to $29/mo.", // null if unchanged, pending or failed
  // additions:
  "id": 42,
  "changedFields": ["price"],
  "summaryStatus": "done", // not_needed | pending | done | failed
}
```

Additions beyond the contract:

| Endpoint                         | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `createdAt` on competitors       | When tracking started.                                           |
| `POST /api/competitors/:id/poll` | Makes a competitor due now (202). Used by the "Poll now" button. |
| `GET .../snapshots?limit=N`      | Page size, default 100, max 500.                                 |
| `GET /healthz`, `GET /readyz`    | Liveness (process up) and readiness (database reachable).        |
| `GET /stub/listings[/:id]`       | The listing stub (see below).                                    |
| `POST /stub/reset` `{ "id"? }`   | Rewinds the stub so a demo can be replayed from version 1.       |

Errors are JSON `{ "error": "<code>", "message": "..." }`. `POST /api/competitors` returns
400 for a malformed id (lowercase letters, digits and dashes), 409 if it is already tracked,
422 if the listing source doesn't know the id, and 503 if the source is unreachable.

## How it works

```
                 ┌──────────────── app process ────────────────┐
  React UI ───▶  │  REST API (Fastify)                          │
                 │                                              │
                 │  Poller loop ──fetch──▶ listing source (stub)│
                 │     │  claim due competitors                 │
                 │     ▼  store snapshot + diff                 │
                 │  Postgres ◀── summary worker loop ──▶ LLM    │
                 └──────────────────────────────────────────────┘
```

### Data model

- `competitors`: the tracked ids plus scheduling state (`next_poll_at`, failure count, last
  error).
- `snapshots`: one row per fetch, including unchanged ones, so the timeline is complete. It
  holds the listing fields, a content hash, `changed`, `changed_fields`, a link to the
  previous snapshot, and the summary with its status, attempt count and next attempt time.
- `summary_cache`: summaries keyed by (previous hash, new hash, model).

Migrations live in `server/src/db/migrations` and run with `npm run migrate`. Docker and
Fly run them automatically.

### Scheduling

Each competitor has its own `next_poll_at`. Every few seconds the poller claims the
competitors that are due and moves their `next_poll_at` forward by the interval (plus up to
10 % jitter) in a single statement:

```sql
UPDATE competitors SET next_poll_at = now() + interval * (1 + random() * 0.1)
WHERE id IN (SELECT id FROM competitors WHERE next_poll_at <= now()
             ORDER BY next_poll_at LIMIT $batch FOR UPDATE SKIP LOCKED)
RETURNING id
```

- **Safe across instances.** Several instances can run this at the same time without
  polling a competitor twice, and no lock service or queue is needed. There's a test for
  concurrent claimers.
- **Fair spreading.** Competitors keep their own schedules instead of being polled all at
  once in a burst, and the jitter keeps them from drifting into lockstep.
- **Bounded concurrency.** Fetches run with limited concurrency (`POLL_CONCURRENCY`), each
  with a timeout.
- **Failure backoff.** A failed fetch writes no snapshot. The competitor is retried after
  15 s, 30 s, 60 s and so on, capped at the normal interval, and the error is stored on the
  row.
- **Durable schedule.** The schedule lives in the database, so a restart never duplicates
  work. On deploy the process gets `SIGTERM`, stops claiming, and has 60 s to finish the
  in-flight polls and LLM calls.
- **One clock.** Every scheduling comparison and every `fetched_at` uses the database clock,
  so clock skew between instances can't reorder the timeline.
- **Scale.** At the scale in the brief (a few hundred competitors every 15 minutes) this
  works out to about 0.3 fetches per second, which a single instance handles easily. The
  `WORKERS_ENABLED=false` flag lets you run API-only replicas if the API ever needs to scale
  separately.

### Diffing

Before comparing, each field is normalized: Unicode NFC, collapsed whitespace and trimmed.
Formatting noise therefore never counts as a change. That matters because every false
positive is a paid LLM call.

The new snapshot is compared field by field with the latest stored snapshot for that
competitor. This runs inside a transaction that locks the competitor row, so two
concurrent polls can't both diff against the same predecessor. The first snapshot of a
competitor counts as "no change".

### AI summaries

The LLM call is deliberately not on the polling path:

1. **Save first.** The poller commits the snapshot first. If it changed, it's stored with
   `summary_status = 'pending'`.
2. **Claim pending jobs.** A separate summary worker loop claims pending snapshots with the
   same `SKIP LOCKED` pattern, but only as many as it calls in parallel (`LLM_CONCURRENCY`).
   - **Lease.** Each claim takes a lease, so if the process dies mid-call, the job comes
     back after the lease expires.
   - **Fencing.** The claim bumps the attempt counter, and every later write requires that
     number. A worker whose lease ran out can never overwrite the result of the worker that
     took over.
3. **Build the prompt.** It contains the computed diff (`price: "$39/mo" -> "$29/mo"`)
   followed by both full listings. The model is told to treat the listing text as untrusted
   data.
4. **Call the model.** Each call has a hard timeout (`LLM_TIMEOUT_MS`, default 15 s). Errors
   are classified: timeouts, 429 and 5xx are retried with exponential backoff and jitter,
   while 400, 401 and 404 fail immediately because retrying won't help. After
   `LLM_MAX_ATTEMPTS` (default 5) the status becomes `failed`.
5. **Reuse identical transitions.** If the same before/after pair was already summarized
   with the same model, the cached summary is reused.

The result is that a slow or failing LLM can delay a summary but never blocks polling,
never loses a snapshot, and never touches the snapshot's data. An unchanged poll makes no
LLM call at all, which you can check with the mock server's `GET /control/stats`.

### Listing source stub

`fixtures/listings.json` is served by an in-process stub at `/stub/listings/:id`. Each call
returns the next version and repeats the last one once the sequence runs out. The poller
reaches it through a small HTTP client, with a timeout and response validation, exactly as
it would reach a real site. Pointing `LISTING_SOURCE_URL` somewhere else swaps it out.

## LLM

| Where                         | LLM                                                     |
| ----------------------------- | ------------------------------------------------------- |
| Local (docker compose, tests) | The provided mock server (`mock-llm/`), no key needed.  |
| Deployed instance             | A real provider through its OpenAI-compatible endpoint. |

The client speaks the OpenAI Chat Completions format with plain `fetch`, so any compatible
endpoint works. Configure it with three variables:

| Provider       | `LLM_BASE_URL`                 | `LLM_MODEL` (example) |
| -------------- | ------------------------------ | --------------------- |
| Mock (default) | `http://localhost:4001/v1`     | `mock-llm`            |
| OpenAI         | `https://api.openai.com/v1`    | `gpt-4o-mini`         |
| Anthropic      | `https://api.anthropic.com/v1` | a Claude Haiku model  |
| Ollama (local) | `http://localhost:11434/v1`    | `llama3.2`            |

Set `LLM_API_KEY` for real providers. The mock's `POST /control/configure` (for example
`{"failNext": 2}` or `{"latencyMs": 20000}`) is a good way to watch the retries and the
timeout working: snapshots keep appearing, summaries show "Summarizing…" and then complete
once the mock recovers.

## Configuration

All configuration comes from environment variables, validated at startup.

| Variable                                         | Default                                  | Notes                                                  |
| ------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------ |
| `DATABASE_URL`                                   | (required)                               | Postgres connection string                             |
| `DATABASE_SSL`                                   | `false`                                  | `true` for hosted Postgres (Supabase)                  |
| `DATABASE_SSL_CA`                                |                                          | PEM of the server CA; enables certificate verification |
| `DATABASE_POOL_MAX`                              | `10`                                     |                                                        |
| `HOST` / `PORT`                                  | `0.0.0.0` / `3000`                       |                                                        |
| `LOG_LEVEL`                                      | `info`                                   |                                                        |
| `POLL_INTERVAL_SECONDS`                          | `60`                                     | Per-competitor polling interval                        |
| `POLL_TICK_MS`                                   | `5000`                                   | How often the poller looks for due competitors         |
| `POLL_BATCH_SIZE` / `POLL_CONCURRENCY`           | `50` / `10`                              |                                                        |
| `LISTING_SOURCE_URL`                             | `http://127.0.0.1:$PORT/stub`            |                                                        |
| `LISTING_FETCH_TIMEOUT_MS`                       | `5000`                                   |                                                        |
| `ENABLE_STUB` / `LISTING_FIXTURES_PATH`          | `true` / `server/fixtures/listings.json` | The fixture-backed stub                                |
| `WORKERS_ENABLED`                                | `true`                                   | `false` for API-only replicas                          |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`     | mock server                              | See [LLM](#llm)                                        |
| `LLM_TIMEOUT_MS`                                 | `15000`                                  |                                                        |
| `LLM_MAX_ATTEMPTS`                               | `5`                                      |                                                        |
| `LLM_CONCURRENCY`                                | `4`                                      | Parallel LLM calls (and jobs claimed per run)          |
| `SUMMARY_TICK_MS`                                | `3000`                                   | How often the summary worker looks for pending jobs    |
| `SUMMARY_RETRY_BASE_MS` / `SUMMARY_RETRY_MAX_MS` | `5000` / `300000`                        | Retry backoff                                          |
| `WEB_DIST_DIR`                                   |                                          | Built web app to serve (set in the Docker image)       |

## Deployment

The live instance runs on **Fly.io** with **Supabase Postgres**:

- **App.** One Fly machine runs the Docker image from this repo. It serves the API, the
  built React app and the background workers. It's always on (`auto_stop_machines = "off"`)
  because the scheduler has to keep running.
- **Migrations.** They run as Fly's `release_command` before each new version starts.
- **Database.** Supabase Postgres, reached through the session pooler with TLS.
- **Secrets.** `DATABASE_URL` and the `LLM_*` variables are Fly secrets. The deployed
  instance polls every 60 s so a reviewer sees all four versions within a few minutes.

To deploy your own:

```bash
fly apps create <app-name>
fly secrets set -a <app-name> \
  DATABASE_URL='postgres://...pooler.supabase.com:5432/postgres' \
  LLM_BASE_URL='https://api.openai.com/v1' LLM_API_KEY='sk-...' LLM_MODEL='gpt-4o-mini'
fly deploy -a <app-name> --ha=false
```

## Assumptions and trade-offs

- **The stub's counter lives in memory**, as the brief describes, because it stands in for
  an external website.
  - Restarting the app starts every sequence over. The diff then correctly reports the
    "change" back to version 1.
  - Removing and re-adding a competitor continues the sequence where the fake site is. Use
    `POST /stub/reset` to replay a demo.
  - Multi-instance safety comes from the scheduler's claim, not from the fake site.
- **Removing a competitor deletes its history** (cascade). Re-adding it starts a fresh
  timeline. Keeping history after removal would be a soft-delete column.
- **The first snapshot is "no change"**, because there is nothing to compare it with.
- **Ids are validated against the source catalog** on `POST` (422 if unknown), which gives
  fast feedback in the UI. A real scraper would validate a URL instead.
- **The summary cache can miss within a batch.** Two identical transitions summarized in the
  same batch may both call the LLM. The cache prevents repeats across batches, which covers
  the realistic case.
- **No auth**, per the brief: a single internal user. This includes the stub's
  `/stub/reset`, which is reachable on the demo deployment on purpose so a demo can be
  replayed. `ENABLE_STUB=false` removes it.

## What I'd add for production

- Metrics such as poll lag, summary queue depth, LLM latency, error rate and token usage,
  with alerts on queue depth and repeated fetch failures.
- A per-provider rate limiter and a daily LLM budget guard.
- Pagination (cursor on `fetched_at, id`) and a retention policy for old unchanged
  snapshots.
- Moving the workers to their own process group once the API needs to scale independently
  (already possible with `WORKERS_ENABLED`).

## AI tools used

I used Claude Code (Anthropic's coding agent) throughout the project: to brainstorm the
design, scaffold the project, write the implementation and tests, and review the code. I
steered and approved the design choices: `SKIP LOCKED` claims for scheduling, keeping the
LLM off the polling path, the retry policy and the summary cache. I also reviewed the result
and checked the failure modes against the mock server. The trade-offs above are the ones I'd
defend.
