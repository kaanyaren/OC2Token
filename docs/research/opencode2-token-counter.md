# OC2Token: OpenCode 2 token counter

## Goal

Build `oc2token`, a macOS-first Node.js CLI installable with npm that opens an
interactive terminal dashboard, in the spirit of CodeBurn, and reports
OpenCode 2 recorded token usage for:

- the last 60 minutes (`hour`)
- the current local calendar day (`day`)
- the current ISO week, Monday through now (`week`)

The default command should stay open, refresh automatically every five minutes,
and support an immediate manual refresh. The CLI should make the time zone and
token definition explicit, and must never silently turn a filtered request into
an all-time report.

## Research findings

### OpenCode 2 status and installation

OpenCode 2 is currently documented as beta software. It installs beside V1,
uses the `opencode2` executable, and the official macOS-friendly npm install
is:

```sh
npm install -g @opencode-ai/cli@beta
```

The package's postinstall selects the native binary for the platform. The
official docs warn that the V2 API and plugin/client contracts can change
before stable release.

Source: [OpenCode 2 introduction](https://opencode.ai/v2/docs) and
[V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/).

### The supported integration boundary is the V2 server API

OpenCode 2 normally owns a shared local background server. The CLI exposes
that server through `opencode2 api`; the command performs local service
discovery/authentication and may start the service when no compatible healthy
service exists. The official JavaScript integration is
`@opencode-ai/client@beta`; its Node service API provides `Service.discover`,
`Service.ensure`, and `Service.headers`.

This is preferable to opening OpenCode's SQLite database as the primary data
source: it keeps database/schema ownership with OpenCode and uses the same
service/authentication path as the CLI.

Sources: [V2 CLI](https://opencode.ai/v2/docs/cli),
[V2 JavaScript client](https://opencode.ai/v2/docs/build/client), and
[V2 troubleshooting](https://opencode.ai/v2/docs/troubleshooting).

### Relevant API surfaces

The generated V2 API currently exposes:

- `GET /api/session/stats` (`v2.session.stats`) for aggregate local session
  activity and usage, with `from`, `to`, `project`, `timezone`, and `tools`
  query parameters.
- `GET /api/session` for paginated sessions.
- `GET /api/session/{sessionID}/message` for paginated projected messages.
- An assistant message contains `time`, `model`, and `tokens`.
- `TokenUsage.Info` contains `input`, `output`, `reasoning`, and
  `cache.read`/`cache.write`.

Sources: [V2 API reference](https://opencode.ai/v2/docs/api) and the generated
[V2 OpenAPI document](https://opencode.ai/v2/openapi.json).

### Runtime validation on this Mac

At research time:

- `opencode2 v0.0.0-beta-18866` was installed at `/opt/homebrew/bin/opencode2`.
- `node v26.5.0` and `npm 11.17.0` were available.
- `opencode2 service status` returned a local server URL.
- `opencode2 api GET /api/health` returned a healthy V2 server.
- The running beta accepted `GET /api/session/stats`, but ignored supplied
  `from`/`to` values and returned an all-time range. Therefore the first
  implementation must probe/validate range behavior and fall back to
  message-level aggregation rather than trust the response blindly.

The message endpoint returned assistant usage records with the expected
token fields. It can also return large message content, so the fallback must
process one page at a time and discard prompt/tool text immediately.

## Proposed architecture

```text
CLI args
  -> dashboard state + refresh scheduler
  -> period/timezone resolver
  -> OpenCode2 connection adapter
  -> range-capability probe
       -> session.stats adapter when the server honors the range
       -> paginated message adapter otherwise
  -> normalized UsageTotals + local snapshot cache
  -> interactive TUI renderer
```

### Primary transport

Use `@opencode-ai/client@beta` plus its Node service API. The adapter should
support both `Service.discover()` and `Service.ensure()` so a closed OpenCode
client does not prevent a read-only usage report. Pin the OpenCode client
compatibility check to V2/beta service versions and keep all transport code in
one module because the beta contract is unstable.

For strict CLI parity, add a diagnostic transport that executes:

```sh
opencode2 api GET /api/health
opencode2 api GET /api/session/stats --param from=... --param to=... \
  --param timezone=... --param tools=none
```

The production implementation should not spawn one `opencode2` process per
session; use the HTTP client for paginated fallback work.

### Range correctness

For every requested range, compare the requested interval with the returned
`data.range`. If the server returns a clearly broader interval, mark the
stats response as unsupported for filtered totals and use the fallback. Never
display that broader total under an hour/day/week label.

The fallback should:

1. List all sessions using the API cursor until exhausted.
2. Fetch each session's messages using message cursors, with bounded
   concurrency.
3. Select assistant messages whose `time.created` is inside the requested
   interval and whose `tokens` object is present.
4. Sum each token component independently; treat absent optional values as
   zero and reject invalid/negative values.
5. Include child/subagent sessions by default because they are OpenCode model
   work. Add an explicit `--exclude-subagents` option only if needed later.
6. Deduplicate by assistant message ID so pagination/retries cannot double
   count a record.

The five-minute dashboard cadence makes this optimization part of the first
usable release, not a distant enhancement. Persist normalized usage records in
an OC2Token-owned data file and incrementally reconcile changed assistant
messages after the initial scan. Do not write to OpenCode's database.

## CodeBurn-style dashboard behavior

CodeBurn's default experience is an interactive TUI dashboard with period
switching, multiple usage panels, keyboard navigation, and refresh controls.
Its documentation also demonstrates a configurable refresh interval and a
manual-refresh mode. OC2Token should adopt that interaction model while
remaining focused on OpenCode 2 and recorded tokens rather than copying
CodeBurn's multi-provider pricing or optimization features.

Sources: [CodeBurn dashboard](https://codeburn.app/docs/dashboard),
[CodeBurn CLI options](https://codeburn.app/docs/cli-options), and
[CodeBurn README refresh behavior](https://github.com/getagentseal/codeburn/blob/main/README.md).

### Default lifecycle

```text
launch -> immediate load -> render dashboard
                     |
                     +-- every 300 seconds -> refresh data -> redraw in place
                     |
                     +-- `r` -> refresh immediately -> reset 300-second timer
```

The refresh loop must:

- run immediately on startup, then every 300 seconds by default;
- allow `r` or `R` to refresh immediately without restarting the CLI;
- allow `--refresh 0` to disable automatic refresh and use manual refresh only;
- prevent overlapping refreshes;
- retain the last successful snapshot when a refresh fails;
- show `Refreshing...`, the last successful update time, and the next refresh
  countdown without disturbing the selected period or scroll position;
- cancel or supersede an in-flight request when the user quits;
- avoid printing prompts, tool output, API keys, or session titles.

### Dashboard layout

The initial TUI should fit a normal macOS terminal and degrade to one column
when narrow:

1. **Header** — `OpenCode 2 Token Usage`, server version, time zone, source,
   last updated, refresh countdown, and stale/error status.
2. **Overview cards** — Last hour, Today, and This week, each showing recorded
   total plus input/output/reasoning/cache summary.
3. **Trend panel** — hourly buckets for the selected day/hour view and daily
   buckets for the week view.
4. **Model/provider panel** — token totals grouped by provider/model, with
   cache fields available in the detail view.
5. **Footer** — `r Refresh`, `1 Hour`, `2 Today`, `3 Week`, `Tab/Arrows Navigate`,
   `q Quit`, and `? Help`.

The dashboard should use stable in-place redraws rather than clear-and-reprint
output, preserve selection across refreshes, and use color only as a secondary
signal so it remains usable in reduced-color terminals.

### Token semantics

Report these fields separately:

```text
input
output
reasoning
cache.read
cache.write
recorded_total = input + output + reasoning + cache.read + cache.write
```

Call the sum `recorded_total`, not `billable_total`: provider billing and
subscription quotas can price or count cache/reasoning tokens differently.
Include provider/model breakdown in JSON and make it a follow-up table option.

## CLI proposal

```sh
# Interactive dashboard; auto-refreshes every 5 minutes
oc2token

# Open focused on one window
oc2token hour
oc2token day
oc2token week

# One-shot automation, never enters the TUI
oc2token --once --json
oc2token week --once --json

# Custom cadence or manual-only dashboard
oc2token --refresh 600
oc2token --refresh 0

# Diagnostics and explicit controls
oc2token doctor
oc2token --timezone Europe/Istanbul
oc2token --project <project-id>
```

`--json` and `--once` are non-interactive modes intended for scripts. The
interactive default is the product's primary experience; a simple table is a
fallback for non-TTY stdout.

Suggested dashboard content:

```text
 OpenCode 2 Token Usage                         Updated 12:00:00  Next 04:59
 Europe/Istanbul · API range verified · beta-18866

┌ Last hour ─────────┐ ┌ Today ────────────┐ ┌ This week ─────────┐
│  Recorded  12.4K   │ │  Recorded  2.1M   │ │  Recorded  14.8M   │
│  In 8.2K Out 4.2K  │ │  In 1.4M Out 700K  │ │  In 9.7M Out 5.1M  │
└─────────────────────┘ └───────────────────┘ └────────────────────┘

 Trend: selected period  ·  Models/providers  ·  Cache summary

 r Refresh   1 Hour   2 Today   3 Week   Tab/Arrows Navigate   q Quit   ? Help
```

`--json` should include the exact `from`, `to`, `timezone`, source, server
version, and component totals so scripts can distinguish a confirmed API
range from a fallback scan. It should also include `lastUpdated`,
`nextRefreshAt` when applicable, and a `stale` flag after a failed refresh.

## Implementation phases

### Phase 1: scaffold and contract

- Initialize a TypeScript ESM Node package.
- Add `bin.oc2token`, `engines.node`, npm publish metadata, README, and a
  license.
- Use Node's built-in argument parser initially to keep runtime dependencies
  small.
- Define `UsageTotals`, `UsageWindow`, `OpenCodeTransport`, and normalized
  error types.

### Phase 2: OpenCode2 connection and stats path

- Implement service discovery/ensure and V2 health/version checks.
- Implement the stats endpoint adapter and range-capability probe.
- Implement window calculations and timezone-aware formatting.
- Add normalized snapshot types and table/JSON renderers.

### Phase 3: accurate fallback

- Implement session and message cursor traversal.
- Add bounded concurrency, message-ID deduplication, component validation,
  and cancellation/timeouts.
- Add fixtures for completed, streaming/incomplete, retried, zero-token, and
  child-session assistant messages.
- Add a fixture reproducing the current beta's ignored-range behavior.

### Phase 4: snapshot cache and dashboard TUI

- Persist only normalized usage metadata in an OC2Token-owned cache; never
  persist prompt or tool text.
- Reconcile new and changed assistant message IDs incrementally on each refresh.
- Build the in-place interactive dashboard with overview cards, trend buckets,
  model/provider breakdown, keyboard navigation, and narrow-terminal layout.
- Add the refresh scheduler: immediate initial load, default 300-second cadence,
  `r`/`R` manual refresh, `--refresh 0` manual-only mode, countdown, and
  stale-while-revalidate error handling.
- Ensure only one refresh runs at a time and preserve the active panel/period
  across redraws.

### Phase 5: performance and UX hardening

- Add `doctor`, model/provider breakdown, and clear source/staleness indicators.
- Add graceful handling for no service, V1-only service, auth failure, empty
  history, API schema mismatch, and partial fallback scans.

### Phase 6: npm release

- Test `npm pack` and install the tarball in a clean temporary Node environment.
- Verify global installation with `npm install -g ./oc2token-*.tgz`.
- Publish under the currently available package name `oc2token` if it remains
  unclaimed; otherwise choose a scoped name before the first release.
- Document that OpenCode 2's beta API may require coordinated OC2Token updates.

## Detailed parallel-subagent implementation plan

There are two different concurrency problems to solve, and they must not be
mixed:

1. **Development-time parallelism** — several coding/research subagents work
   on OC2Token at the same time.
2. **Runtime parallelism** — OC2Token reads several OpenCode 2 sessions while
   OpenCode 2 is simultaneously running root and child/subagent sessions.

OC2Token v1 is a read-only observer; it does not launch model subagents of its
own. It must nevertheless treat OpenCode 2's child sessions as first-class
usage sources. OpenCode 2 documents foreground and background subagents as
child sessions, and its server surface exposes session hierarchy and a global
event stream. See [V2 agents](https://opencode.ai/v2/docs/agents), the
[V2 server/client API](https://opencode.ai/v2/docs/build/client/effect/), and
the [session endpoints](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx).

### A. Development-time parallelism

#### A1. Coordinator and worktree rules

Use one coordinator/integrator and one isolated git worktree plus branch per
subagent. The coordinator owns the base branch, integration order, shared
contracts, and final acceptance. Do not ask multiple agents to edit the same
file and then resolve the result with last-write-wins or a blind cherry-pick.

Before launching agents:

1. Record `git status --short` and preserve unrelated dirty files; never use
   `reset --hard`, `clean`, or broad stash operations as a coordination tool.
2. Create a clean baseline commit containing only the OC2Token scaffold and
   plan. If the repository is not yet initialized, initialize git before
   creating worktrees.
3. Freeze the domain contract in a small, stable seam before feature agents
   begin. The seam should expose deep modules such as:

   ```ts
   interface UsageSource {
     collect(request: CollectionRequest): Promise<CollectionResult>
   }

   interface SnapshotStore {
     read(): Promise<StoredSnapshot | null>
     commit(snapshot: StoredSnapshot): Promise<void>
   }

   interface Clock {
     wallNow(): Date
     monotonicNow(): number
   }
   ```

   The interfaces include cancellation, ordering, completeness, and error
   semantics in their documentation; the type signatures alone are not the
   contract. Each adapter accepts dependencies instead of constructing them so
   fake clocks, transports, and stores can exercise race cases deterministically.
4. Give each agent an explicit allowed-path list. Shared files such as
   `package.json`, the lockfile, `tsconfig.json`, `src/index.ts`, and the main
   README have one owner: the coordinator. Agents submit a requested change
   to those files in their report rather than editing them concurrently.
5. Require every agent to return a structured report: files changed, tests
   run, assumptions, contract changes requested, known failure modes, and
   unresolved race risks. A successful process exit is not sufficient evidence
   of correctness.

#### A2. Agent topology and ownership

After the contract agent completes, the following agents can run in parallel.
The paths are intentionally disjoint; test agents may read other paths but do
not modify their production files.

| Agent | Mission | Owns | Depends on | Deliverable |
|---|---|---|---|---|
| `contracts` | Define domain values and fake seams | `src/domain/**`, contract fixtures | none | Types for windows, token components, snapshots, coverage, errors, and fake adapters |
| `opencode-adapter` | Connect to OpenCode 2 | `src/opencode/**` | `contracts` | Service discovery/ensure, health/version check, stats capability probe, paginated transport |
| `collector` | Produce correct usage records | `src/collector/**`, `src/accounting/**` | `contracts` | Session graph discovery, bounded worker pool, cursor traversal, deduplication, token validation |
| `cache` | Make persistence crash- and process-safe | `src/cache/**` | `contracts` | Versioned normalized-record store, atomic snapshots, lock handling, migration/recovery |
| `dashboard-state` | Own refresh lifecycle | `src/dashboard/state/**`, `src/dashboard/scheduler/**` | `contracts` | Single-flight refresh coordinator, generation rules, fake-clock scheduler, stale state |
| `renderer` | Render the CodeBurn-style TUI and non-TTY output | `src/dashboard/render/**`, `src/output/**` | `contracts` | Responsive ANSI/TUI layout, JSON schema, stable redraw, keyboard actions |
| `qa` | Attack the seams with deterministic faults | `test/**` | `contracts` | Race, property, pagination, DST, cancellation, stress, and fixture tests |
| `release` | Package and operational documentation | `docs/**`, `README.md` only | integrated build | npm pack/install checks, doctor documentation, beta compatibility notes |

The `package.json`, lockfile, executable entry point, and final README merge
remain coordinator-owned to prevent dependency and bin-script races. If an
agent needs a dependency, it records the request; the coordinator applies it,
runs the focused package test, and publishes the resulting lockfile to the
next worktree.

#### A3. Barriers and integration order

Use explicit barriers rather than starting all agents against moving
interfaces:

```text
contracts
   |------------------ shared contract review ------------------|
   v                                                          v
adapter   collector   cache   dashboard-state   renderer   qa-fixtures
   \          |         |          |              /          /
    \---------+---------+----------+-------------/----------/
                         v
                   integration review
                         v
                  release / npm checks
```

Recommended integration sequence:

1. Merge `contracts`; run typecheck and contract tests.
2. Merge `opencode-adapter`; run transport tests and a live read-only health
   check if an OpenCode 2 service is available.
3. Merge `collector` and `cache` separately; compare collector output against
   a serial test oracle before combining them.
4. Merge `dashboard-state`; prove scheduler behavior with a fake monotonic
   clock before connecting a terminal renderer.
5. Merge `renderer`; manually smoke-test a real terminal after the focused
   tests pass.
6. Merge `qa` and fix failures in the owning worktree, not in the test branch.
7. Run the release agent only after the integrated package has deterministic
   one-shot output and no unresolved partial-data semantics.

Each merge gate runs `git diff --check`, the narrowest relevant tests, and then
the package-wide test/typecheck when the shared contract or dependency graph
changes. The integration reviewer checks that no agent edited outside its
ownership list and that no test merely asserts a mocked result while skipping
the real state transition.

#### A4. If OC2Token later launches subagents itself

If a future feature asks OC2Token to run model subagents for summaries or
diagnostics, add a separate `SubagentCoordinator` module rather than allowing
the renderer or collector to fan out directly. Its small interface should
accept a DAG of immutable work items and return `Promise<ReadonlyArray<Result>>`.
Each work item must have:

- a stable `workId` and idempotency key;
- a role, prompt reference, allowed paths, dependencies, attempt number, and
  deadline;
- state transitions `queued -> running -> succeeded | failed | cancelled |
  timed_out` recorded by the coordinator only;
- an isolated worktree or artifact directory;
- a structured result envelope that contains status, files, tests, and errors,
  never raw prompts, credentials, or uncontrolled terminal output.

The coordinator must enforce a maximum fan-out and maximum nesting depth,
reject cycles and duplicate work IDs, use `Promise.allSettled` so one failure
does not strand siblings, and cancel descendants when the parent is cancelled.
Retries create a new attempt record but must reuse the same idempotency key;
non-idempotent side effects are never retried automatically. A barrier cannot
open until all required predecessors have terminal states, and an integrator
must explicitly resolve conflicting artifacts. This prevents recursive
subagent explosions, shared-file corruption, and a successful sibling masking
the failure of a required sibling.

### B. Runtime parallelism in the token collector

#### B1. Immutable refresh generations

All automatic and manual refreshes enter one `RefreshCoordinator`. The TUI
event loop is the only writer of visible state; workers return values and never
mutate renderer state directly.

```text
RefreshRequest {
  generation: number
  reason: "initial" | "timer" | "manual" | "wake"
  wallNow: Instant
  monotonicStartedAt: number
  timezone: string
  project?: string
  signal: AbortSignal
}
```

Rules:

1. Capture one wall-clock `now` at refresh start. Derive hour/day/week
   intervals from that instant; do not let each worker calculate its own
   boundary.
2. Use a monotonic clock for timer intervals and countdowns. Wall-clock time
   is only for usage-window labels and displayed timestamps.
3. Increment `generation` for every accepted refresh request. A result may be
   committed only if its generation is still current and the request was not
   cancelled. Late worker completions are discarded.
4. Never run two full refreshes concurrently. If `r` is pressed while a
   refresh is active, set one `pendingManual` flag and run exactly one fresh
   follow-up after the current request completes. Coalesce timer ticks while
   busy; do not build an unbounded timer queue.
5. On quit, abort the active request, stop scheduling, ignore late results,
   await bounded cleanup, and restore terminal mode in a `finally` path.
6. A refresh commits one immutable `UsageSnapshot`, not individual card or
   panel updates. The renderer swaps the whole snapshot on the event loop, so
   hour/day/week cards can never come from different refresh generations.

This is a single-flight/latest-generation design: it avoids both duplicate
requests and the classic race where a slower automatic request overwrites a
newer manual result.

#### B2. Session graph and work queue

Use `sessionID` as the identity of a session, not a title, model, or parent
path. Enumerate sessions once from the paginated session endpoint; if child
enumeration is used, maintain a global `seenSessionIDs` set so a child found
through both the root list and `/children` is scanned once. Preserve
`parentID`/lineage only as metadata and for diagnostics.

The collector uses a bounded queue:

```text
ScanJob {
  generation
  sessionID
  cursor
  attempt
  intervalUnion
}
```

Recommended initial limits are four session workers, eight total in-flight HTTP
requests, a finite page size, and per-request timeouts. Make the limits
constants behind configuration so a live beta service can be protected from a
large history without exposing an unsafe unlimited flag. Pages for one session
remain sequential because cursor order is a per-session consistency aid;
different sessions are scanned in parallel.

The fallback should scan the union from the earliest needed boundary to the
single captured `now`, then derive all three dashboard windows in memory. It
must not scan hour, day, and week independently, because that would triple the
work and create three opportunities to count the same assistant message.

Workers should:

- process one page at a time and discard message content/tool parts
  immediately;
- emit normalized usage records to a serial reducer rather than writing the
  cache themselves;
- deduplicate by `(sessionID, messageID)` and upsert the newest token object;
- never add a retry's result as a delta; the reducer recomputes totals from
  canonical records;
- prioritize sessions with recent activity, while guaranteeing eventual
  service for older sessions;
- stop accepting work when the generation is cancelled or a memory/error budget
  is exceeded.

Do not combine a valid `/session/stats` total with fallback message totals for
the same window. Choose exactly one source per snapshot. If stats range
validation fails, use the fallback for that refresh and record the reason.

#### B3. Stable accounting model

Normalize every usage-bearing assistant message to:

```text
UsageRecord {
  key: sessionID + "/" + messageID
  createdAt
  model
  input
  output
  reasoning
  cacheRead
  cacheWrite
  tokenRevision
  observedAt
  completeness: "final" | "provisional"
}
```

The record key, not array position or page number, is the idempotency key.
`tokenRevision` can be a stable hash of the token fields and terminal metadata.
If the same message is returned with changed usage on a later refresh, replace
the record and recompute the affected windows. This handles streaming,
provider retries, late settlement, and corrected usage without double counting.

Count a message only when it has valid non-negative token components and a
recognized final usage state. If the beta response provides tokens before a
terminal state, retain it as provisional, show it only under an explicit
provisional/partial policy, and rescan it on the next refresh. Missing token
fields are zero only for optional fields; a missing token object is not an
implicit zero-cost completed message.

Child sessions are included once by default. A root assistant message and a
child assistant message have different composite keys, so both are counted as
model work without treating parent/child traversal as two copies. Never add
stats output and child-session output together when the stats endpoint already
includes the child work.

#### B4. Cache and process coordination

The cache is an OC2Token-owned read model, not a second OpenCode database.
Use a versioned record file plus an immutable snapshot manifest:

```text
read records -> reduce -> write unique temp file
             -> flush/fsync file
             -> atomic rename in the same directory
             -> publish snapshot manifest/version
```

Specific safeguards:

- Serialize cache commits within one process.
- Use an exclusive lock file or lock directory for cross-process writers. The
  lock contains PID, host, start time, and a random owner token.
- Before removing a stale lock, verify that its owner is dead or its age is
  beyond the stale threshold, then re-check the lock identity before unlinking;
  this avoids deleting a newly reused lock after PID reuse.
- Give every temporary file a unique name. Never let a second CLI instance
  overwrite another instance's temp file.
- Readers accept only a complete manifest and the referenced file. A crash
  before rename leaves the previous snapshot intact; a crash during startup
  recovery removes only orphaned temp files.
- If another process owns the lock, continue with an in-memory snapshot and
  visibly report `cache_busy`; do not block the dashboard forever or discard
  the current process's correct data.
- Store no prompt text, tool input, API keys, or session titles. Restrict
  permissions on cache files and document the local metadata retained for
  deduplication.
- Include a schema version and migration path. An unknown future schema is
  read as unavailable/stale, never parsed as if it were the current schema.

The cache is an optimization and recovery aid, not proof that a scan was
complete. Every snapshot carries source, server fingerprint, generation,
requested interval, and coverage metadata.

#### B5. Discovery and pagination races

Session and message collections can change while they are being read. The
collector must be correct under duplicates and honest about unavoidable gaps:

- **New child during enumeration:** record a session-list watermark at refresh
  start, complete the initial listing, then perform one bounded second pass for
  sessions created before the captured `now`. If the service cannot provide a
  stable boundary, set `coverage.sessionDiscovery = "unstable"` and mark the
  snapshot partial rather than claiming exactness.
- **Message inserted between pages:** deduplicate IDs, tolerate a repeated
  page, and rescan a small overlap on the next refresh. If cursor invalidation
  is reported, restart that session from its newest page once, then mark it
  partial if the second attempt fails.
- **Message updated while being read:** upsert by key and revision; never add
  the changed response to the old value.
- **Session deleted or returns 404:** keep the last observed normalized records
  for that session in cache with `sourceState = deleted`, exclude it from new
  discovery, and mark the current scan partial if the deletion could affect
  the requested interval.
- **Empty page with a continuation cursor:** follow the cursor with a guard
  against repeating cursor values. A repeated cursor is a protocol error, not
  permission to loop forever.
- **Malformed page or unexpected schema:** fail only that job, preserve other
  session results, record a bounded diagnostic, and mark coverage partial.
- **Huge message content:** use the smallest supported projection/page size;
  process and release page data immediately; impose a maximum response/page
  budget and surface a clear partial error if exceeded.

#### B6. Service, network, and beta-version races

- **Service disappears or restarts:** health-check once per refresh, retry
  idempotent GETs with exponential backoff and jitter, and invalidate the
  client/connection on connection reset. Do not restart or mutate the user's
  OpenCode service from a read-only report.
- **Endpoint changes during a refresh:** capture health/version metadata at
  the beginning and end. If it changes, discard mixed-source aggregates and
  retry as a new generation once; otherwise publish a snapshot labeled with
  the observed version.
- **401/403:** stop retrying, report authentication/service ownership clearly,
  and retain the last good snapshot. Do not print authorization headers.
- **429/5xx/timeouts:** retry only idempotent reads, obey `Retry-After` when
  valid, cap attempts and total refresh time, and reduce worker pressure after
  repeated throttling. A retry is never allowed to increment totals directly.
- **SSE/event stream disconnect:** treat events as invalidation hints only. The
  official client documents live streams as ending on EOF/failure without
  automatic replay, so reconnect and perform a bounded full/reconciliation
  scan; never use an event delta as the accounting source.
- **Stats range regression:** probe once per server fingerprint and cache the
  capability briefly. Compare response range with the requested range on every
  use; invalidate the probe after a version change. A response that ignores
  `from`/`to` is fallback-triggering, not acceptable data.

#### B7. Time, sleep, and terminal races

- **DST transition:** calculate intervals from timezone-aware instants using one
  timezone resolver. A local day may be 23 or 25 hours; do not assume 24.
- **Week boundary:** use the configured locale-independent ISO Monday rule and
  test Sunday-to-Monday rollover around midnight.
- **Clock adjustment:** the scheduler uses monotonic time; the displayed
  interval uses wall time captured for the generation. If wall time jumps
  backwards/forwards materially, annotate the snapshot and start a fresh
  generation.
- **Mac sleep/wake:** timer callbacks may be delayed. On wake, run one
  `wake` refresh immediately, coalescing with any active refresh, and reset the
  next deadline from monotonic time; do not replay every missed five-minute
  tick.
- **Resize during redraw:** terminal-size events enqueue state updates on the
  same event loop as snapshots. Debounce resize, render from one immutable
  snapshot, and never let a worker write escape sequences.
- **`q`/SIGINT/SIGTERM during network I/O:** abort all requests, stop workers,
  wait for the reducer to stop accepting records, and restore cursor/raw mode
  even when cleanup itself reports an error.
- **Manual refresh during an error:** allow `r` to retry immediately, but
  still enforce one active request and bounded backoff. Keep the stale snapshot
  visible while the retry runs.
- **Narrow or non-TTY output:** the dashboard renderer must not assume a
  minimum width. Use a one-column layout or deterministic table/JSON, and do
  not emit ANSI control sequences to a pipe.

#### B8. Partial-result semantics

Every collection returns coverage, not just numbers:

```text
Coverage {
  complete: boolean
  sessionsDiscovered
  sessionsScanned
  sessionsSkipped
  pagesRead
  jobsRetried
  provisionalMessages
  errors: [{ code, sessionID?, retryable }]
}
```

The dashboard shows `complete`, `partial`, or `stale` next to the source and
last successful update. It never silently substitutes the previous snapshot
for a current one. On failure, keep the last successful totals visible but
attach the new error and timestamp. In JSON, expose both the snapshot and
coverage; for one-shot automation, use a documented non-zero exit code for a
partial/error result while still emitting valid JSON when requested.

### C. Concurrency-focused verification plan

Implement the correct serial collector first, then use it as the oracle for
the bounded-parallel collector. Do not approve parallel speedups until both
produce byte-equivalent normalized records and totals for the same fixture.

#### C1. Deterministic unit and property tests

- Fake `Clock`, transport, lock, and filesystem adapters; never use real time
  or random sleeps in race tests.
- Run the same fixture repeatedly with randomized worker completion order,
  duplicate pages, reordered pages, repeated cursors, missing fields, 404s,
  timeout/retry sequences, and token revisions.
- Assert invariants after every interleaving: no negative totals, no duplicate
  record keys, no mixed generations, no cache corruption, and parallel total
  equals serial oracle.
- Property-test window partitioning so the sum of derived hour/day/week
  buckets is based on records, not on three independent scans.
- Generate DST, ISO-week, clock-jump, and sleep/wake schedules with a fake
  monotonic clock.

#### C2. Integration fixtures

Create a local fake OpenCode 2 server with at least:

- multiple root sessions and nested child sessions;
- two sessions updating simultaneously;
- a streaming assistant message that becomes final between refreshes;
- the same message appearing on two pages and changing token usage after a
  retry;
- a child created during the first session-list pass;
- session deletion, service restart, 401, 429, 500, malformed JSON, and
  ignored `from`/`to` stats behavior;
- a large-content response proving content is not persisted;
- cache lock ownership by another process and crash-recovery temp files.

#### C3. Stress and manual acceptance

- Stress with at least 1,000 sessions, 10,000 usage-bearing messages, four
  workers, forced random delays, and a bounded-memory assertion.
- Exercise automatic and manual refresh at the same instant, manual refresh
  during an active request, quit during a retry, two CLI instances sharing a
  cache, and a service restart during page traversal.
- Manually verify a real macOS terminal: immediate load, five-minute refresh,
  `r` refresh, `--refresh 0`, stale state, resize, narrow width, reduced color,
  sleep/wake, and terminal restoration after `q`/Ctrl-C.
- Run `npm pack` and install the tarball in a clean temporary Node environment;
  test both TTY and piped JSON modes against the fake server and one live
  OpenCode 2 beta service.

### D. Commit-sized execution sequence

Use small commits so parallel work can be integrated without cross-branch
conflicts:

1. `scaffold package and domain contracts` — coordinator + `contracts`.
2. `add fake clock transport and serial collector` — `collector` + `qa`.
3. `add OpenCode2 service adapter and range probe` — `opencode-adapter`.
4. `add bounded session worker pool and reconciliation` — `collector`.
5. `add atomic versioned cache and lock recovery` — `cache`.
6. `add single-flight refresh coordinator` — `dashboard-state`.
7. `add CodeBurn-style TUI and deterministic output` — `renderer`.
8. `add fault injection stress and integration fixtures` — `qa`.
9. `add doctor, packaging, and npm acceptance checks` — coordinator + `release`.

The coordinator should stop and review if any change crosses an ownership
seam, changes token semantics, changes partial-result policy, or changes the
meaning of a refresh generation. Those are architecture decisions, not merge
conflicts to resolve opportunistically.

## Acceptance criteria

- `npm install -g oc2token` installs a working `oc2token` executable on
  Apple Silicon and Intel macOS.
- Running `oc2token` enters an interactive dashboard and performs an immediate
  first load.
- The dashboard refreshes automatically every 300 seconds by default; pressing
  `r` refreshes immediately, and `--refresh 0` disables automatic refresh.
- A failed refresh leaves the last successful data visible and clearly marks it
  stale; refreshes never overlap or reset navigation state.
- With a running OpenCode2 beta, the dashboard reports all three windows
  without exposing prompts, tool output, API keys, or session titles by default.
- A known fixture's five token components and recorded total are exact.
- A server that ignores `from`/`to` triggers the fallback or a visible error;
  it never produces a mislabeled all-time result.
- JSON output is stable enough for shell automation and includes source and
  range metadata.
- Non-TTY stdout uses a deterministic table or JSON mode instead of emitting
  terminal control sequences.
- Tests cover DST/time-zone boundaries, Monday week boundaries, pagination,
  duplicate pages, missing token fields, assistant messages outside the
  window, refresh scheduling, manual refresh, stale snapshots, and terminal
  resize/redraw behavior.

## Open decisions before implementation

1. Keep the recommended window semantics (rolling hour, local day, ISO week)
   or make all three rolling windows.
2. Use a Node TUI renderer such as Ink, or keep the first dashboard on a
   dependency-light ANSI renderer.
3. Use the unscoped npm name `oc2token` or reserve a scoped package name for
   the project.
