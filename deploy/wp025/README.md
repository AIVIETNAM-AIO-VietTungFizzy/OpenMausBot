# WP02.5 + Ollama workload scheduler: integration, release and rollback

This is the release procedure for the `mausbots` production host (Mac Studio,
OpenMausBot in Docker Compose, one shared Ollama serving `qwen3.8:27b`). It
covers getting the production customizations (WP02.5) into Git, combining them
with the workload scheduler, deploying with the scheduler **off**, turning it on
in a separately approved step, and rolling back.

Every step that changes production is marked **Approval required**. Nothing in
this file was run against production when it was written.

## Refs

| Ref | Commit | What it is |
|---|---|---|
| `f55d45c` | `f55d45c6e0764ec78e5ba8b0427150656dc94c92` | The upstream commit production is checked out at |
| `ollama-workload-scheduler` | `c00fdd4bb1d06667f5227d4f8f144d7305c8c6da` | The original scheduler commit, on `f55d45c`. Never rewritten |
| `claude/modest-noether-x7u2rs` | see `git log` | The scheduler commit plus hardening, tests and these docs, on `f55d45c` |
| `wp025/production-snapshot` | created in step 2 | `f55d45c` plus WP02.5 exactly as it runs in production |
| `integration/wp025-ollama-scheduler` | created in step 3 | The merge of the two above: the release candidate |
| `main` | `3aec210054cdbafec0701100796335f0de1a5b8e` | Upstream's current `main`, 3,451 commits past `f55d45c`. Not part of this release |

Do not open a pull request from any of these branches into `main`: the diff
would carry 3,451 unrelated upstream commits. Review the release against
`f55d45c` instead (`git diff f55d45c...integration/wp025-ollama-scheduler`), or
against a `production` branch created at `f55d45c` once the owner agrees to one.

## 1. Preserve WP02.5 (on `mausbots`, read-only)

Production's WP02.5 changes are uncommitted in `~/workspace/OpenMausBot`. The
snapshot script copies them out without writing anything inside that checkout.
It needs `git`, `tar` and `shasum`, and nothing from this repository's
dependencies.

Copy the script to the host outside the checkout, then run it:

```bash
scp deploy/wp025/snapshot-production-changes.sh mausbots:~/snapshot-production-changes.sh
```

```bash
ssh mausbots 'bash ~/snapshot-production-changes.sh ~/workspace/OpenMausBot f55d45c6e0764ec78e5ba8b0427150656dc94c92'
```

It writes `~/omb-release-snapshots/wp025-<UTC time>/` (directory mode 0700,
files 0600):

| File | Contents |
|---|---|
| `base.txt` | HEAD, branch, remotes with credentials redacted, git and Node versions |
| `status.txt` | `git status --porcelain` of every tracked and untracked change |
| `tracked.patch` | `git diff --binary HEAD`: every change to tracked files, staged or not |
| `staged.patch` | what was staged, kept only to record staging |
| `untracked.tar.gz` | untracked files that are not ignored and not secret-looking by name |
| `untracked-not-copied.txt` | untracked files left out by name (`.env*`, keys, databases, logs, `data/`): names only |
| `ignored-inventory.txt` | ignored paths, names only |
| `SHA256SUMS` | checksums of the above |

The script stops with exit code 3, and archives nothing, if any copied change
holds secret-like text. It lists where (file and line, never the value) in
`secret-scan-hits.txt`. Only when every location is a false positive, run it
again with `OMB_SNAPSHOT_ACCEPT_SCAN_HITS=1`. A real secret must be moved into
runtime configuration before WP02.5 is committed anywhere.

It warns if HEAD is not `f55d45c`. In that case, stop and plan the integration
on the actual base.

Then:

1. Read `status.txt` and `untracked-not-copied.txt`. Confirm the inventory:
   at least `server/index.ts`, `server/container-computer.ts`,
   `server/routes/computers.ts` and the untracked `server/chat-vm-*` modules
   are expected. Anything else must be explained by whoever made WP02.5.
2. Copy the snapshot directory off the host to the development Mac, and keep a
   second copy in an encrypted backup. Verify it there with
   `shasum -a 256 -c SHA256SUMS`.

## 2. Reproduce production in Git (development Mac)

Work in a new worktree so no existing checkout changes:

```bash
cd /Users/fizzy/Documents/Works/a-chau/mausbot/OpenMausBot && git fetch origin
```

```bash
git worktree add -b wp025/production-snapshot ../omb-wp025 f55d45c6e0764ec78e5ba8b0427150656dc94c92
```

```bash
cd ../omb-wp025 && git apply --index ~/omb-release-snapshots/wp025-<time>/tracked.patch && tar xzf ~/omb-release-snapshots/wp025-<time>/untracked.tar.gz
```

Check that `git status --porcelain` lists the same paths as `status.txt`, then
commit:

```bash
git add -A && git commit -m "WP02.5: production customizations as deployed on mausbots"
```

This branch is production as it runs: building it reproduces the current
image's code. Before pushing it, confirm whether the fork is public; WP02.5
becomes visible to everyone who can read the fork.

## 3. Integrate

```bash
git worktree add -b integration/wp025-ollama-scheduler ../omb-integration origin/claude/modest-noether-x7u2rs
```

```bash
cd ../omb-integration && git merge --no-ff wp025/production-snapshot
```

A merge keeps both the scheduler commits and the WP02.5 commit as they are.
Expect conflicts in `server/index.ts`. The scheduler's changes there are small
and each one is a single call site:

| Scheduler change in `server/index.ts` | Where |
|---|---|
| imports of `turnWorkload` and `createWorkloadHost` | the `createTurnOrder` import line |
| `createTurnOrder(...)` kept as `personsOwnWork` and passed to `engineMemory.useTurnOrder` | the `turnResources` line |
| `!facts.modelBusy` in `fileIncident` | the turn-settled handler |
| `workload: turnWorkload(personsOwnWork(threadId), bot.id, threadId)` | `beginTurn`'s `sendTurn` input |
| `workload: turnWorkload(personsOwnWork(threadId), readyBot.id, threadId)` | `runClaimedGroupMemberTurn`'s `sendTurn` input |
| `const workloadHost = createWorkloadHost({ ..., bots: () => store.bots })` and `...workloadHost.routineOptions` | before `new RoutineManager` |
| `workloadHost.runChanged(run)` | `onRunChanged` |
| `workloadHost.adopt(routines)` | after the routine manager is built |
| `ROUTES.push(workloadHost.routes())` | before `createStatusRoutes` |
| `workloadHost.close()` | `gracefulShutdown`, after `coordinator.close()` |

Keep every WP02.5 line and every scheduler line. If WP02.5 adds another place
that calls `sendTurn` (for example a Local VM or chat-VM turn), give it a
`workload` the same way, or it is counted as `unclassified` interactive work.

A clean merge is not proof that the two work together. Before calling the
candidate ready:

1. Run the checks in step 4.
2. Add integration tests for each WP02.5 path that starts a model request
   while a VM is attached (attach, run a turn, detach; shared Local VM with two
   bots; MCP bridge mounted), with the scheduler on and with it off, against
   the fake Ollama in `server/workload/openai-compat-scheduler.test.ts`.
3. Record every failure, and whether it also fails on
   `wp025/production-snapshot` (an existing WP02.5 defect) or only on the
   integration branch (a scheduler regression). Fix only the regressions in
   this release.

## 4. Validate the candidate (Node 24)

```bash
node --version
```

It must print `v24.x`. Then:

```bash
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint
```

```bash
npx vitest run server/workload
```

```bash
OMB_VITEST_WORKERS=4 npx vitest run server/drivers server/routine server/routines server/side-jobs server/turn-outcome server/quota-switch server/host server/routes scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts src/locales
```

```bash
OMB_VITEST_WORKERS=4 npx vitest run server/group-local-vm.e2e.test.ts server/openai-compat-vm.e2e.test.ts server/desktop-computer.e2e.test.ts server/mcp-restart.e2e.test.ts server/mcp-selection.e2e.test.ts server/routine-recovery.e2e.test.ts
```

Run the same commands on `wp025/production-snapshot` and compare.

## 5. Build and deploy with the scheduler off

**Approval required.** This restarts OpenMausBot, which stops running turns.
Pick a quiet window and announce it.

Before anything changes, record what runs now (read-only):

```bash
cd ~/workspace/OpenMausBot && git rev-parse HEAD && git status --porcelain | wc -l
```

```bash
docker compose ps && docker compose images && docker compose exec omb node --version
```

```bash
docker compose config | grep -E 'OPENMAUS_OLLAMA|image:|context:|dockerfile:'
```

The last command shows which Compose file and build context production uses.
The repository's root `compose.yaml` wraps the published upstream image, while
`deploy/docker-compose.yml` builds this checkout; the steps below assume the
running image is built from the checkout. If `docker compose config` shows
otherwise, stop and adjust this plan. It must also show no `OPENMAUS_OLLAMA_*`
variable.

Keep the current image for rollback (substitute the image name `docker compose
images` printed):

```bash
docker tag <current omb image> openmausbot-rollback:pre-wp025-scheduler
```

Back up the data volume (stop-free copy of the files; `routines.json` and the
SQLite files are what matter):

```bash
docker compose exec omb tar czf - -C /data . > ~/omb-release-snapshots/data-pre-wp025-scheduler.tgz
```

Build the release candidate in a separate worktree on the host, never in the
production checkout, which still holds WP02.5 as uncommitted changes:

```bash
git -C ~/workspace/OpenMausBot fetch origin integration/wp025-ollama-scheduler
```

```bash
git -C ~/workspace/OpenMausBot worktree add ~/workspace/omb-release <integration commit sha>
```

Build from that worktree with the production Compose file and project name, so
the same volumes are used. `--no-cache` without `--pull` rebuilds every layer
on the Node 24 base image already on the host:

```bash
cd ~/workspace/omb-release && docker compose -p <production project name> -f <production compose file> build --no-cache omb
```

Deploy, without `-v` and without `down`, so volumes and configuration stay:

```bash
docker compose -p <production project name> -f <production compose file> up -d omb
```

Verify:

1. `docker compose ps` shows `omb` healthy.
2. `docker compose exec omb node --version` prints the same `v24.x` as before.
3. `GET /api/workload` as the owner returns `"enabled": false` and no schedulers.
4. Send one message to a bot on the shared Ollama and one to a bot using the
   shared Local VM; both answer. Check desktop and computer routing and the MCP
   bridge on one bot.
5. Routines due during the window run.
6. `docker compose logs omb | grep -c '\[omb-scheduler\]'` prints `0`.

Watch for a day before step 6.

## 6. Turn the scheduler on

**Approval required, separately from step 5.**

Before turning it on, `GET /api/workload` must show an empty `ungoverned` list,
or the owner accepts each entry (see "Policy for requests it cannot admit" in
`docs/ollama-workload-scheduler.md`). Confirm Ollama still runs one reply at a
time (`OLLAMA_NUM_PARALLEL=1`); this procedure never changes Ollama.

Add to the `omb` service's environment in the production Compose override:

```env
OPENMAUS_OLLAMA_SCHEDULER_ENABLED=1
OPENMAUS_OLLAMA_MAX_ACTIVE_INFERENCE=1
OPENMAUS_OLLAMA_MAX_INTERACTIVE_WAITING=2
```

Leave every other `OPENMAUS_OLLAMA_*` variable at its default. Restart `omb`
only (`docker compose up -d omb`).

Monitor for the first hours:

```bash
curl -s -H "authorization: Bearer <owner token>" https://<host>/api/workload | jq '{enabled, schedulers: [.schedulers[] | {key, active: (.active|length), interactiveWaiting: (.interactiveWaiting|length), backgroundWaiting: (.backgroundWaiting|length), counters: {completed: .counters.completed, failed: .counters.failed, rejected: .counters.rejected, cancelledWaiting: .counters.cancelledWaiting, cancelledActive: .counters.cancelledActive, modelSwitches: .counters.modelSwitches, overdueNewTurnGrants: .counters.overdueNewTurnGrants}, timings: {wait: .timings.interactiveWait.p90Ms, service: .timings.service.p90Ms, ttft: .timings.timeToFirstToken.p90Ms}}], ungoverned, backgroundJobs}'
```

```bash
docker compose logs --since 1h omb | grep '\[omb-scheduler\]' | grep -oE '"event":"[a-z_]+"' | sort | uniq -c
```

Turn it off again (step 7a) if any of these hold:

- `maxObserved.active` is above 1 for the Ollama origin;
- more than one scheduler is listed for the one Ollama;
- `rejected.wait-timeout` keeps rising while `active` is empty;
- `backgroundJobs.counts.queued` keeps growing for an hour while interactive
  traffic is low;
- people report "model is busy" notices at a rate the owner does not accept.

## 7. Roll back

**Approval required.**

a. Scheduler only: remove the three variables, `docker compose up -d omb`.
   Requests go to Ollama exactly as before. `workload-jobs.db` stays in the
   data directory and is ignored while the flag is off. Routine runs keep their
   own state in `routines.json`, so none is lost. When the scheduler is turned
   on again, live ledger rows whose routine run no longer exists are closed as
   `orphaned` at startup.

b. Whole release: point the service back at the image tagged in step 5 and
   recreate the container:

```bash
docker tag openmausbot-rollback:pre-wp025-scheduler <the image name the omb service uses> && docker compose up -d --no-build omb
```

   The previous build never reads `workload-jobs.db`. Leave the file in place.
   Restore the data backup only if the data itself is damaged, and only with
   the service stopped.

c. Verify as in step 5 (health, Node version, one message per kind of bot, a
   routine run), and check that `git -C ~/workspace/OpenMausBot status
   --porcelain` still lists the WP02.5 changes: the production checkout is
   never modified by this procedure.
