# Ollama workload scheduler

Many bots can share one Ollama server that runs one reply at a time
(`OLLAMA_NUM_PARALLEL=1`). Without admission control every bot's request goes
straight to Ollama and waits in Ollama's own queue (up to `OLLAMA_MAX_QUEUE`,
512 by default). Ollama sends nothing, not even HTTP headers, while a request
waits, so OpenMausBot's reply timer (`OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS`,
180 s by default) cannot tell a queued request from a dead one.

The workload scheduler admits those requests in the OpenMausBot server instead.
It is off by default and changes nothing until it is turned on.

## What it guarantees

For each Ollama server (scheme, host and port of the engine's URL; every name
for this machine, such as `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, its
host name or one of its interface addresses, counts as one server):

| Rule | Default |
|---|---|
| Requests sent to Ollama at once | 1 |
| Interactive requests waiting behind it | 2 |
| Waiting places one bot may hold, later rounds included | 1 |
| Later rounds of other turns that may pass a waiting new turn | 2 |
| Longest an interactive request waits | 180 s, then a busy notice |
| Background requests waiting in memory | 8 |
| Background request goes ahead of waiting people after | 120 s, at most every other dispatch |

The scheduler is one object per origin for the whole server process. Every bot
and every engine instance that sends to that origin shares it. The data-directory
lease (`openmausbot-server.lease`) already guarantees one server process per data
directory, so no cross-process coordination is needed.

A request holds its slot from the moment it is admitted until its reply stream
ends, fails, is stopped, or its connection drops. The slot is released exactly
once on every path. The first token arriving does not release it.

The reply timer starts only once the slot is held, so time spent in this queue
never counts as a silent model. Queue time has its own limit (the interactive
wait limit above).

## What is interactive and what is background

Classification happens where the server starts the work, never from prompt text
or from anything in a request body.

| Work | Class | Where |
|---|---|---|
| A person's own message in a 1:1 chat or a room, and a turn going on from their answer | interactive | `turnWorkload` at both turn dispatch sites in `server/index.ts`, using the same person-first rule engine memory uses (`host/turn-order.ts`) |
| Routine runs (schedule, manual, webhook, app trigger, bot API), hand-offs between bots, incident reports, meetings, other unattended turns | background | same |
| Compaction summary, setup-card suggestions | interactive helper | `side-jobs.ts` |
| Memory upkeep, skill review, representative, status replies | background helper | `side-jobs.ts` |
| Generated thread titles | background helper | `thread-title-generate.ts` |
| Settings → check engine | interactive (`setup-check`) | `engine-check.ts` |
| Anything without a classification | interactive, counted as `unclassified` | driver default |

A turn makes one model request per round. Its first request is a new request.
Every later round (after tools ran) is a **continuation**: it goes ahead of new
requests in its own lane, interactive or background. A continuation is refused
only when every waiting place in its lane already holds another continuation.
If the lane is full when a continuation arrives, the newest waiting new request
is refused instead (`displaced`; it has not run anything yet, so nothing is left
half-done).

Continuations cannot starve a waiting new turn: once two later rounds of other
turns have gone ahead of it, it goes next (`overdueNewTurnGrants` counts these).
A bot's waiting later round counts toward its one waiting place, so one bot
cannot hold both interactive places. Two turns of the same bot that are both
mid-way can each have a later round waiting; refusing either would cut off work
whose tools already ran.

Background aging is measured from the oldest request in the background lane.

## The busy notice

A refused request never reaches Ollama. The turn ends with a `runtime.error`
whose `text.key` is `chat.notice.modelBusy`:

> The local model is busy with other bots' requests, so this message was not
> sent to it. Try again in about N seconds.

N is estimated from the recent average service time and what is ahead, between
10 and 300 seconds. The error object (`OllamaBusyError`) carries
`code: "OLLAMA_BUSY"`, `status: 503`, the reason and `retryAfterSeconds`.
OpenMausBot has no synchronous HTTP endpoint that waits on a model reply, so the
notice reaches the person through the chat, not as an HTTP 503 response.

A busy refusal is never retried automatically:

- **Teammate threads:** they are not retried, and no Chief incident is filed.
- **Model choice:** a busy refusal is not a usage limit, so it never switches a bot to a backup engine or model.
- **Routine runs:** they treat it as "busy". The existing routine behaviour then re-checks every 30 s for up to an hour, as it does for a busy bot.

The classification uses the notice key, not the message's words.

## Background jobs

Routine runs are the persistent background jobs. `routines.json` already keeps
their prompt, their state (queued, running, waiting, completed, failed,
cancelled, missed), their retries and their restart recovery. The scheduler adds
two things.

**An admission gate.** A queued run starts only when the shared model has room
for background work: no request running, and none of a person's waiting. A run
that has waited longer than the aging limit starts anyway. Until then it stays
queued as "busy" through the routine manager's existing deferral, and its owner
gets the usual deferral notice. It is never dropped.

**A durable ledger.** `DATA_DIR/workload-jobs.db` (SQLite, file mode 0600)
holds one row per job with these fields:
- job id and dedupe key (`routine-run:<run id>`)
- bot id, thread id, task type (`routine:<trigger>`) and model
- created, queued, started and finished times
- status
- result reference (the thread holding the result)
- error class and attempt count

Prompts and replies are never stored there.

The ledger also bounds and repairs itself:
- **Capacity:** at most `OPENMAUS_OLLAMA_BACKGROUND_QUEUE_MAX` live jobs (default 200). Past that, a new run stays queued in `routines.json` and is admitted once room frees up.
- **Restart:** a job running at restart goes back to the queue, unless it has used `OPENMAUS_OLLAMA_BACKGROUND_JOB_MAX_ATTEMPTS` (default 2) attempts.
- **Orphans:** at startup, rows whose routine run is no longer live are closed as `orphaned`.
- **Pruning:** settled rows older than 7 days are deleted.

Cancelling a job (`POST /api/workload/jobs/<id>/cancel`) cancels its routine run.
The ledger then settles through the routine's own lifecycle.

Background turns that are not routine runs keep their existing persistence and
failure handling. The scheduler only queues their model requests in the bounded
background lane:

| Work | Survives a restart | When its first request is refused (`background-full`) |
|---|---|---|
| Routine runs | Yes: `routines.json` plus the ledger | Treated as busy: re-checked every 30 s for up to an hour; a run still refused after that fails like any run that stayed busy that long (its owner is notified and a `routine-failed` incident is filed) |
| Hand-offs between bots, unattended room turns, meetings, incident reports | Only what the existing turn and room recovery already keeps | The turn ends with the busy notice in its thread; nothing retries it and no Chief incident is filed |
| Memory upkeep, skill review, representative, status replies, thread titles | No | That one helper call fails as it would on any other model error, with that job's existing error handling |

A later round is not refused while the lane has a new request it can displace,
so a background turn is cut off mid-way only when every background place
already holds another turn's later round. If that happens to a routine run, the
run is re-checked as busy and later starts again from the beginning. Making the
non-routine background turns durable needs its own job record per kind of work
and is not part of this feature.

## Settings

All are read from the server's environment at start.

| Variable | Default | Meaning |
|---|---|---|
| `OPENMAUS_OLLAMA_SCHEDULER_ENABLED` | off | `1`, `true`, `on` or `yes` turns the scheduler on |
| `OPENMAUS_OLLAMA_MAX_ACTIVE_INFERENCE` | 1 | Requests sent to one Ollama origin at once (1–8). Keep 1 unless Ollama's own parallelism was raised and measured |
| `OPENMAUS_OLLAMA_MAX_INTERACTIVE_WAITING` | 2 | Interactive requests that may wait (0–32) |
| `OPENMAUS_OLLAMA_MAX_WAITING_PER_BOT` | 1 | Waiting places one bot may hold (1–32) |
| `OPENMAUS_OLLAMA_INTERACTIVE_MAX_WAIT_MS` | 180000 | Longest an interactive request waits before a busy notice |
| `OPENMAUS_OLLAMA_BACKGROUND_WAITING_MAX` | 8 | Background model requests waiting in memory (1–256) |
| `OPENMAUS_OLLAMA_BACKGROUND_QUEUE_MAX` | 200 | Live background jobs in the ledger (1–10000) |
| `OPENMAUS_OLLAMA_BACKGROUND_AGING_POLICY` | `age:120` | `off`, or `age:<seconds>` after which a background request or run goes ahead of waiting people, at most every other dispatch |
| `OPENMAUS_OLLAMA_BACKGROUND_JOB_MAX_ATTEMPTS` | 2 | Attempts before a job cut off by restarts fails |

A value outside its range leaves the default. The `OPENMAUS_` prefix keeps these
apart from Ollama's own `OLLAMA_*` variables, which this feature never reads or
changes.

## Diagnostics

`GET /api/workload` (owner or admin only; never prompts or replies) returns, per Ollama origin:

- **Limits and live state:** the limits, what is running (bot, class, source, model, running time, time to first token) and what waits in each lane.
- **Peaks and age:** the largest active count and queue depths seen, and the age of the oldest background request.
- **Counters:**
  - requests received, admitted at once, queued, completed and failed;
  - cancellations, split into waiting and running;
  - refusals by reason (`queue-full`, `bot-share`, `wait-timeout`, `displaced`, `background-full`, `shutdown`);
  - requests by class, by source and by bot;
  - unclassified requests;
  - observed model switches;
  - aged background grants;
  - waiting new turns served after later rounds passed them twice (`overdueNewTurnGrants`).
- **Timings** (count, mean, p50, p90 and max over the last 200 requests):
  - interactive queue wait;
  - background queue wait;
  - service time (slot held);
  - time to first token after admission;
  - total time.
- **Retry hint:** the current retry-after estimate.
- **Background jobs:** counts by status, the age of the oldest queued job, and how many were refused because the ledger was full.
- **Ungoverned senders** (`ungoverned`): bots and project tasks whose CLI engine uses an injected Ollama model, with the Ollama server it sends to and whether a scheduler admits other requests to that same server (`sharesGovernedOrigin`).

`GET /api/workload/jobs?status=queued&limit=50` lists ledger rows,
`GET /api/workload/jobs/<id>` reads one, and `POST /api/workload/jobs/<id>/cancel`
cancels one.

Each request also logs one JSON line per lifecycle step with the
`[omb-scheduler]` prefix:
- `request_received`
- `request_classified`
- `request_queued`
- `request_rejected`
- `inference_slot_acquired`
- `ollama_request_sent`
- `first_token_received`
- `stream_completed`
- `request_cancelled`
- `request_failed`
- `model_switch_observed`

Lines carry:
- ids: request, bot, thread and task;
- class, source and model (the model the bot selected);
- `waitMs`, `serviceMs`, `ttftMs` and `totalMs`;
- a reason;
- queue depths.

They never carry prompt text, replies, tool results or keys. Queue wait
(`waitMs`) and execution (`serviceMs`) are separate fields.

```bash
docker compose logs omb | grep '\[omb-scheduler\]' | grep -c request_rejected
```

## What it does not govern

- Other OpenMausBot installs (another container or data directory, the desktop
  app) sending to the same Ollama.
- Engine CLIs (Claude Code, Codex, ACP agents) pointed at Ollama through a local
  model choice (`ollama::<model>`). They run as their own processes and call
  Ollama directly. `GET /api/workload` lists them under `ungoverned`.
- The CLI's API-key setup "test reply" (`server/cli-api-setup.ts`), a one-off
  check of at most 30 seconds while someone sets up a key.
- Ollama's non-inference routes (`/api/version`, `/api/tags`, `/api/ps`,
  `/api/show`, `/api/create`) and the `/v1/models` liveness probe.
- Other providers: cloud APIs, LM Studio, llama.cpp and any local server that
  does not answer Ollama's `/api/version`.

Model selection and the context-window naming (`-omb-<n>k`) are unchanged. The
scheduler observes model switches and never chooses a model.

### Policy for requests it cannot admit

None of these is blocked: blocking would change which model a bot uses, and
model routing stays manual. Instead:

1. Before turning the scheduler on, `GET /api/workload` must show an empty
   `ungoverned` list, or each entry must be accepted by the owner. To bring a
   bot under the scheduler, move it to the OpenAI-compatible engine that points
   at the same Ollama.
2. Exactly one OpenMausBot server sends to a shared Ollama. A second install
   (another container, data directory or the desktop app) must use a different
   Ollama or none.
3. Ollama itself stays at one reply at a time (`OLLAMA_NUM_PARALLEL=1`), so a
   request from outside the scheduler waits in Ollama's queue rather than
   running beside an admitted one. While it waits, the admitted request's reply
   timer runs: a long outside request can make an admitted one time out.
4. Engine setup checks from the terminal (`openmausbot setup`) are one-off
   requests of at most 30 seconds; run them outside busy hours.

Inside a container, `127.0.0.1` is the container itself. An engine that reaches
the host's Ollama through `host.docker.internal` and a CLI engine's injected
model at `127.0.0.1:11434` are different servers to the scheduler, whatever any
port forwarding joins.

## Turning it on and off

On:
1. Set `OPENMAUS_OLLAMA_SCHEDULER_ENABLED=1` for the `omb` service.
2. Restart it. The restart stops running turns.
3. Watch `GET /api/workload` and the `[omb-scheduler]` log lines.

Off:
1. Remove the variable, or set it to `0`.
2. Restart.

With the flag off, no scheduler or ledger is created and requests go to Ollama
exactly as before. `workload-jobs.db` may stay on disk and is ignored.
