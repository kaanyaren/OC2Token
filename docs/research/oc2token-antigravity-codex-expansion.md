# OC2Token Antigravity + Codex Expansion — Parallel Subagent Implementation Map

## Goal
Extend `oc2token` from single-source (OpenCode 2) to unified multi-provider dashboard supporting:
- OpenCode 2 (existing: `stats` vs `message-scan`)
- Codex CLI (`~/.codex/sessions/**/rollout-*.jsonl`)
- Antigravity CLI (`~/.gemini/antigravity-cli/conversations/*.db`)

Default `oc2token` sums **all** providers into one `hour/day/week` view with a provider breakdown. Cost is out-of-scope for v1 (tokens only). 5-component token model is reused (`input,output,reasoning,cacheRead,cacheWrite → recorded_total` at `src/domain/tokens.ts:3`).

## Decisions Locked (from Q&A 2026-09-02)
| Decision | Choice | Rationale |
|---|---|---|
| Default view | **Unified** (`src/application.ts:62` sums all, flag filters) | Match CodeBurn unified report; `oc2token --source opencode` etc filters |
| Parser strategy | **Native only** (no `codeburn` subprocess) | No external runtime dep, deterministic |
| Token model | **Map to 5** (`src/domain/tokens.ts:14` `TOKEN_COMPONENT_NAMES`) | Keeps `UsageRecordReducer`, `sumUsageRecords`, cache stable |
| Cost v1 | **Tokens only** (`src/output/table.ts:44` stays) | Avoid `litellm-pricing.json` sync |

---

## Discovery Summary (verified on this Mac: Node 26.5.0, opencode2 beta-18866)

### Codex CLI
```
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl   # primary, per codeburn dist/main.js:5560
~/.codex/archived_sessions/rollout-*.jsonl
~/.codex/history.jsonl, state_5.sqlite/threads, thread_history_1.sqlite # not authoritative for tokens
```
Each JSONL line:
```json
{"type":"session_meta","payload":{"session_id":"...","timestamp":"2026-07-27T19:08:55.140Z", ...}}
{"type":"event_msg","timestamp":"2026-07-27T19:18:50.268Z","payload":{"type":"token_count","info":{
  "total_token_usage":{"input_tokens":123573,"cached_input_tokens":69632,"cache_write_input_tokens":0,"output_tokens":2975,"reasoning_output_tokens":239,"total_tokens":126548},
  "last_token_usage":{"input_tokens":8954,"output_tokens":2306,"cached_input_tokens":29440,"reasoning_output_tokens":67,"cache_write_input_tokens":0}
}}}
```
Mapping (codeburn dist/main.js:6329):
```
uncached = last.input - last.cached
cacheWrite = min(last.cache_write, uncached) if model cacheWrite explicit else 0
billedInput = uncached - cacheWrite
input=billedInput, output=last.output, reasoning=last.reasoning, cacheRead=last.cached, cacheWrite=billed
dedupKey = codex:{sessionId}:{total.total_tokens}:{total.input}:{total.cached}:{total.output}:{total.reasoning}
timestamp = event.timestamp (UTC ISO)
```
Fork guard: skip if `event.timestamp < session_meta.timestamp + 5s`. Delta-from-total fallback when `last_token_usage` is `null`. `node:sqlite` available (verified `DatabaseSync` function).

### Antigravity CLI
```
~/.gemini/antigravity-cli/conversations/*.db   # 220 files, each SQLite
  tables: trajectory_meta, steps, gen_metadata(idx,data BLOB), executor_metadata, trajectory_metadata_blob
~/.gemini/antigravity-cli/conversations/*.db-shm/wal
```
`gen_metadata.data` is protobuf (codeburn dist/main.js:17114 `readProtoVarint/parseProtoFields`):
```
root = parseProtoFields(blob)
chat = parseProtoFields(field1.bytes)
usage = parseProtoFields(chat.field4.bytes)  # wireType 2
  input = usage.field2 || usage.field1
  totalOutput = usage.field3
  response = usage.field9
  thinking = usage.field10
  responseId = usage.field11 || String(idx)
model = chat.field19 || chat.field20["model_enum"] || chat.field21 → canonical
timestamp = chat.field9.field4 → protoTimestampToIso (text or sec+nanos)
pricingModel = strip -high/-medium/-low
cost not stored → tokens only v1
```
`cacheRead/Write = 0` for SQLite path (Gemini). `cascadeId = basename(path, .db)`. dedupKey `antigravity:{cascadeId}:{responseId}`. Root traversal stats: no `timestamp` index — filter in memory via `containsInstant(window, createdAt)` (`src/domain/windows.ts:322`).

### Codeburn reference
`codeburn 0.9.23` at `/opt/homebrew/lib/node_modules/codeburn` already parses both correctly (`codex-results.v15.json`, `antigravity-results.v5.json` under `~/.cache/codeburn/`). Our port reuses its field numbers, not its runtime. Verified via subagent extraction: `walkRolloutFiles:5560`, `getRawTokenUsage:5811`, `parseCodexLine:5884`, `buildCallFromSqliteGenMetadataRow:17240`, `openDatabase:7688` using `node:sqlite`.

---

## Architecture Delta

```
Before: CLI → ApplicationSource(HybridUsageSource(stats|message-scan) → CachedUsageSource) → CollectionResult → Dashboard/Table/JSON

After : CLI --source filter → UnifiedUsageSource
                               ├─ HybridUsageSource (opencode)    [existing, unchanged]
                               ├─ CodexFileSource  (JSONL scan)    [new src/codex/]
                               └─ AntigravityFileSource (SQLite→proto) [new src/antigravity/]
                                      ↓
                               UnifiedReducer (UsageRecordReducer) → totalsByWindow / modelsByWindow / providersByWindow
                                      ↓
                               CachedUsageSource (schema v2) → Dashboard (unified cards + provider stack)
```

Key invariants preserved:
- One `capturedAt` captures all windows (`src/domain/windows.ts:315` `createUsageWindows`) — all providers bucket against same instant.
- `UsageRecord.completeness` stays `"final"` for Codex/Antigravity (no provisional; stream already settled).
- `recorded_total = sum(5)` (`src/domain/tokens.ts:188`) — not billed.
- `coverage.complete=false` if any provider returned partial/error.

---

## Ticket Graph (DAG — blocking edges as text)

```
T0 domain-provider-extension
│
├─► T1 codex-scanner ──────────────┐
│                                   │
├─► T2 antigravity-proto-port ─────┤
│          │                        │
│          └─► T3 antigravity-scanner
│                                   │
└─► T4 cache-schema-v2 ───────────► T5 unified-aggregator ──► T6 output-unified ──► T7 cli-source-filter + doctor
                                     │                          │
                                     └──────────────────────────┘
T8 qa-fixtures (spans T1-T7, last gate)
```

Blocking edges (agent must not start until predecessors merged + typecheck):
- T1,T2,T4 block on T0
- T3 blocks on T2
- T5 blocks on T1,T3,T4
- T6 blocks on T5
- T7 blocks on T5,T6
- T8 final gate blocks on T7 (but writes tests incrementally alongside — owns `test/**` only)

---

## Tickets (file ownership, deliverable, verification)

### T0 — Domain: provider extension
**Owns:** `src/domain/contracts.ts`, `src/domain/records.ts`, `src/domain/tokens.ts` (doc only), `src/domain/index.ts`
**Do:**
- `src/domain/contracts.ts:6` extend `CollectionSource = "stats" | "message-scan" | "codex" | "antigravity" | "unified"`; add `type ProviderKind = "opencode" | "codex" | "antigravity"`.
- `src/domain/contracts.ts:50` add `provider: ProviderKind` to `CollectionRequest` (optional filter) — actually filter lives on aggregator, keep request pure.
- `src/domain/records.ts:26` add `readonly provider: ProviderKind` to `UsageRecord` (required). Update `UsageRecordInput`, `createUsageRecord` validation, `usageRecordKey` stays `sessionID/messageID` but document that cross-provider same ID is impossible (prefix differs). Add `provider` to key? Keep key stable — provider is metadata, not key part.
- `src/domain/contracts.ts:28` extend `UsageBreakdown` to carry `provider`? Already `name/provider`. Instead add `ProvidersByWindow = Record<ProviderKind, UsageTotals>` and extend `CollectionResult` with `readonly providersByWindow?: ProvidersByWindow` already exists? Keep but populate with `ProviderBreakdown` entries.
- `src/domain/tokens.ts:3` doc: mapping table for Codex/Antigravity cache fields.
- Export new types at `src/domain/index.ts`.
**Verify:** `npm run typecheck`, `npm test` contract fixtures pass; no production behavior change yet.

### T1 — Codex: file scanner
**Owns:** `src/codex/**` (`scanner.ts`, `discovery.ts`, `types.ts`, `index.ts`)
**Depends:** T0
**Do:**
- `discovery.ts`: port `walkRolloutFiles` (`codeburn:5560`) — `readdirSync` over `~/.codex/sessions/YYYY/MM/DD` + `archived_sessions`, path override via `CODEX_HOME` env (codeburn `providers/codex.ts` discovery). Export `discoverRolloutFiles(root?)`.
- `scanner.ts`: `collectCodex(request: CollectionRequest): Promise<CollectionResult>` implements `UsageSource`. For each file: `readFileSync` slice 64k head optimization optional, but simple is `readFile` line-split + `JSON.parse` per line (bench: <50 ms per 200KB rollout). Filter `type==="event_msg" && payload.type==="token_count"`. Replicate fork guard (`entry.timestamp` vs `session_meta.timestamp+5s`), `prevCumulativeTotal` dedup, `last_token_usage` delta logic (`dist:6329`), `total_token_usage` fallback. Map to `UsageRecord` via `createUsageRecord`. Time bucket: only emit records where `containsInstant(window, createdAt)` for any `request.windows` (union). Use `UsageRecordReducer` for dedup by `key=codex/${sessionId}/${dedupKey}` (dedupKey as tokenRevision). Coverage: count `sessionsDiscovered=cascadeCount`, `sessionsScanned`, `pagesRead=filesRead`, `jobsRetried`.
- Handle `CODEX_HOME` missing → return empty complete result (no error).
- Unit-map: `billedInputTokens`, `cacheReadInputTokens`, `billedCacheWrite`.
**Verify:** fixture: 3 rollouts with 2 `token_count` each, one fork replay, one without `last_token_usage` → totals equal `sum(last)` vs `sum(delta)`. `npm run build && node --test dist/test/codex/**`.

### T2 — Antigravity: protobuf port
**Owns:** `src/antigravity/proto.ts`, `src/antigravity/proto.test.ts` (owned by T2, not qa)
**Depends:** T0
**Do:**
- Port `readProtoVarint`, `parseProtoFields`, `firstProtoField`, `protoFieldBytes/Text/PositiveInteger`, `antigravitySqliteModel/CreatedAt/ResponseId`, `protoTimestampToIso` from `dist/main.js:17114-17330` to `src/antigravity/proto.ts` pure functions with no `node:sqlite` dep.
- Support wire types 0 (varint), 2 (len-delim). Use `BigInt` for 70-bit varint.
- Canonical model: port `getCanonicalModelId` stub (strip `-high/-medium/-low/-agent`, map `gemini-3.7-flash` etc) or import minimal map.
- Exhaustive unit tests: craft buffers for each field number (1,2,3,4,9,10,11,19,20,21) and assert parsing. Include timestamp sec+nanos path.
**Verify:** `node --test dist/test/antigravity/proto.test.js` reproduces codeburn field extraction for 2 captured `gen_metadata` blobs (checked vs `antigravity-results.v5.json`).

### T3 — Antigravity: SQLite scanner
**Owns:** `src/antigravity/scanner.ts`, `src/antigravity/discovery.ts`, `src/antigravity/index.ts`
**Depends:** T2, T0
**Do:**
- `discovery.ts`: scan `~/.gemini/antigravity-cli/conversations` (plus `antigravity`, `antigravity-ide`, `implicit` fallbacks per `dist:1674`). Allow `ANTIGRAVITY_HOME` override. List `*.db` (ignore `-shm/-wal`).
- `scanner.ts`: `collectAntigravity(request): Promise<CollectionResult>` uses `node:sqlite` `DatabaseSync(path,{readOnly:true})` per `dist:7688`. Query `SELECT idx, data FROM gen_metadata ORDER BY idx`. For each row, `buildCallFromSqliteGenMetadataRow(cascadeId,row)` via T2 proto. Map to `UsageRecord` with `provider="antigravity"`, `sessionID=cascadeId`, `messageID=responseId`, `model`, `createdAt=timestamp` (fallback mtime if missing via `assignStableTimestamps`), `input/output/reasoning` mapped to 5, `cacheRead/Write=0`. Store `dedupKey` as `tokenRevision`. Filter by `request.windows` via `containsInstant`. Deduplicate via `UsageRecordReducer` on `key=antigravity/${cascadeId}/${responseId}`.
- Handle `isSqliteAvailable()` false → empty result + `coverage.errors=[{code:"unknown", message:"node:sqlite unavailable"}]`.
- Handle `SQLITE_BUSY` (file locked) → `coverage.sessionsSkipped++`, retry once, then mark partial.
**Verify:** use 2 checked-in `.db` fixtures (small) copied from `~/.gemini/...` (sanitized), assert `sumUsageRecords` equals `cat ~/.cache/codeburn/antigravity-results.v5.json | jq` slice. No prompt content asserted.

### T4 — Cache: schema v2
**Owns:** `src/cache/schema.ts`, `src/cache/store.ts`, `src/cache/types.ts`, `src/cache/index.ts`
**Depends:** T0
**Do:**
- `src/cache/types.ts:10` bump `CURRENT_CACHE_SCHEMA_VERSION 1→2`, extend `CacheManifest` with `providerFingerprints?: Record<ProviderKind,string>`.
- `src/cache/schema.ts:13` extend `PersistedRecord` with `readonly provider: ProviderKind` + `readonly sessionID/messageID` already. Update `normalizeRecord`/`toDomainRecord` to round-trip `provider`. Update `migrateRecordsDocument` to migrate v1→v2: `provider ?? "opencode"` for legacy. Update `safeSnapshotValue` allowlist to keep `provider`.
- `src/cache/store.ts`: handle `schemaVersion 2` write, `1` read via migration. Keep atomic rename + lock logic unchanged (`src/cache/lock.ts`).
**Verify:** `npm run build && node --test dist/test/cache/**` include migration test v1→v2 and future-schema reject.

### T5 — Unified aggregator
**Owns:** `src/application.ts`, `src/collector/types.ts` (if needed), `src/domain/windows.ts` (read-only)
**Depends:** T1,T3,T4
**Do:**
- In `src/application.ts:61` keep `HybridUsageSource` unchanged.
- Add `CodexFileSource` and `AntigravityFileSource` wrappers delegating to T1/T3 (or inject directly).
- New `UnifiedUsageSource implements UsageSource`:
  ```ts
  class UnifiedUsageSource implements UsageSource {
    constructor(readonly opencode: UsageSource, readonly codex: UsageSource, readonly antigravity: UsageSource) {}
    async collect(req: CollectionRequest): Promise<CollectionResult> {
      const [o,c,a] = await Promise.allSettled([opencode.collect(req), codex.collect(req), antigravity.collect(req)]);
      // collect errors into coverage.errors with provider prefix
      // merge records via UsageRecordReducer (deterministic sort by provider/key)
      // compute totalsByWindow = sumUsageRecords(reducer.records(), window)
      // compute modelsByWindow/providersByWindow partitioned by record.provider/model
      // source="unified" if >1 provider present else original
    }
  }
  ```
- Extend `ApplicationOptions` (`src/application.ts:260`) with `codexDirectory?`, `antigravityDirectory?`.
- Update `createApplicationSource` to build unified source and wrap with `CachedUsageSource` (now v2).
- Window semantics: use single `intervalUnion(request.windows)` scan union; filter per provider then merge — avoids triple scan.
**Verify:** fixture with 1 opencode record (day) + 1 codex (hour) + 1 antigravity (week) → `totalsByWindow` reflects unified sums, provider breakdown correct, coverage union.

### T6 — Output: unified rendering
**Owns:** `src/output/table.ts`, `src/output/json.ts`, `src/dashboard/render/dashboard.ts`, `src/dashboard/render/types.ts`, `src/dashboard/render/format.ts`
**Depends:** T5
**Do:**
- `src/dashboard/render/types.ts`: extend `DashboardSnapshotInput` normalize to include `providers: BreakdownTotal[]` (already) but now 3 providers; `normalizeDashboardSnapshot` sorts by `recorded_total` desc.
- `src/dashboard/render/dashboard.ts:254` cards stay hour/day/week totals (unified). Below cards, render provider stack: `Providers · opencode X (Y%) · codex …` using `themePurple/themeOrange` + third accent (add `themeCyan` in `src/dashboard/render/ansi.ts`).
- `src/output/table.ts:42` add section `Providers` already; ensure unified totals row shows `Source: unified` + per-provider rows.
- `src/output/json.ts:56` `StableJSONSnapshot` add `totalsByProvider: Record<ProviderKind, UsageTotals>` per window; keep `schemaVersion:2` bump or keep 1 with additive field (prefer 2). Ensure `coverage.errors` includes provider-tagged errors.
- Narrow layout (`width<78`) stacks provider rows vertically.
**Verify:** `test/renderer/output.test.ts` snapshot: unified fixture with 2 providers renders both without ANSI when `color:false`.

### T7 — CLI: --source filter + doctor
**Owns:** `src/cli.ts`, `src/opencode/doctor.ts`, `src/codex/doctor.ts` (new), `src/antigravity/doctor.ts` (new)
**Depends:** T5,T6
**Do:**
- `src/cli.ts:83` `parseArgs` add `--source <opencode|codex|antigravity|all>` repeatable; store `Set<ProviderKind>`; default `all`. Filter at `UnifiedUsageSource` construction (or pass `CollectionRequest` with `providers` filter). Reject unknown. `doctor` subcommand gains optional `--source`.
- `runOnce`/`runDashboard` construct `createApplicationSource` with filtered sources.
- `src/opencode/doctor.ts` (existing) add `codex`/`antigravity` checks: probe directories, count files/DBs, attempt one parse, report `ok: filesFound>0 && parseOk`.
- Help text `usage()` updated. Keep `doctor` json passthrough.
**Verify:** `oc2token --source codex --once --json` emits `providers` with only codex; `oc2token doctor --json` reports 3 checks.

### T8 — QA: fixtures & stress (final gate)
**Owns:** `test/**` (all), `docs/research/oc2token-antigravity-codex-expansion.md` (this file)
**Depends:** T7 (but writes incrementally)
**Do:**
- Fixtures: `test/fixtures/codex/rollout-*.jsonl` (2), `test/fixtures/antigravity/*.db` (2 small cloned DBs, <50KB, git-lfs ok).
- Property tests: random worker completion order still deterministically sorted by reducer; DST (`America/New_York` 2026-03-08 02:00 skip) + ISO week Monday.
- Cancellation: `AbortSignal` during `Unified` cancels all three.
- Parallel oracle: serial `sum(last)` equals parallel scanner total.
**Verify:** `npm run build && npm test` full suite; `git diff --check` clean.

---

## Worktree & Guardrails (from docs/research/opencode2-token-counter.md:326)

- One **coordinator** (integrator) owns base branch, lockfile, `package.json`, `tsconfig.json`, `README.md`. Agents request dep adds via report.
- Each ticket gets **isolated git worktree + branch** per `A1` rules. Agent allowed-path list enforced by coordinator review (no `src/index.ts` edits by workers).
- Explicit barriers (see graph). Integration sequence: T0→(T1|T2|T4)→T3→T5→T6→T7→T8.
- Verification per merge gate: `git diff --check`, narrowest `node --test dist/test/<area>.test.js`, then `npm run typecheck` when contracts/cache changed. Full `npm test` only at T8 final gate (incremental caches already typechecked).
- `node:sqlite` gate: T3 skips cleanly if `DatabaseSync` unavailable; CI must use Node ≥22.13 (repo engines `>=20` but map requires `>=22.13` for `node:sqlite` — bump or document fallback).
- No prompt/tool content persisted — `src/cache/schema.ts:233` `FORBIDDEN_KEY` allowlist enforced; antag DB `executor_metadata`/`steps` blobs are not read at all (only `gen_metadata`), proving no leakage.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Antigravity `.db` schema drift (protobuf field numbers shift) | Pin field numbers from codeburn 0.9.23; add `coverage.errors` path for unknown field → fallback to mtime-based empty, not crash; revisit on `antigravity --version` bump |
| Codex JSONL >100MB (power user) | Stream line-split, process one file at a time, discard non-`token_count` lines immediately; cap `pageLimit` analogue `MAX_CODEX_FILES=1000` |
| Double-count Codex delta fallback mistake | Mirror codeburn `prevCumulativeTotal` logic; test against `codeburn` cache golden file for this Mac's 1 file |
| Cache v1→v2 migration on future schema | `migrateRecordsDocument` throws `cache-corrupt` for >CURRENT; doctor surfaces |
| Narrow terminal provider stack overflow | `format.ts` truncation reuses `safeIdentifier` + `truncate` |

---

## Next Step: Launch

Coordinator creates worktrees:
```sh
git worktree add ../OC2Token-t0-domain -b feat/t0-provider-extension
git worktree add ../OC2Token-t1-codex -b feat/t1-codex-scanner
git worktree add ../OC2Token-t2-proto -b feat/t2-antigravity-proto
# T4 can share T0 worktree after T0 merge, etc.
```
and dispatches parallel subagents per topology above. Say "launch T0" to start.

