import { promises as nodeFs } from "node:fs";
import { basename } from "node:path";

import { createUsageRecord, containsInstant, sumUsageRecords } from "../domain/index.js";
import { UsageRecordReducer } from "../accounting/reducer.js";
import {
  DomainError,
  cancellationError,
  isCancellationError,
  toCollectionError,
} from "../domain/index.js";
import type {
  CollectionRequest,
  CollectionResult,
  Coverage,
  CollectionError,
  UsageRecord,
  UsageBreakdown,
  UsageBreakdownsByWindow,
  UsageTotalsByWindow,
} from "../domain/index.js";

import { discoverRolloutFiles } from "./discovery.js";

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    throw cancellationError(reason instanceof Error ? reason.message : undefined);
  }
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readRawNumber(raw: unknown, field: string): number {
  if (raw !== null && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const v = rec[field];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
  }
  return 0;
}

function sortedErrors(errors: ReadonlyArray<CollectionError>): ReadonlyArray<CollectionError> {
  return [...errors].sort((a, b) =>
    (String(a.sessionID ?? "") + "\0" + a.code + "\0" + a.message).localeCompare(
      String(b.sessionID ?? "") + "\0" + b.code + "\0" + b.message,
    ),
  );
}

/**
 * Upper bound for a single rollout file read. Files larger than this are
 * skipped with a coverage error instead of being loaded into memory, so one
 * giant JSONL cannot OOM the scanner.
 */
const MAX_ROLLOUT_BYTES = 256 * 1024 * 1024;

/**
 * Domain record IDs reject "/" (it joins the stable `session/message` key)
 * while cache SAFE_ID permits it. Rollout payloads are untrusted input, so
 * sanitize every ID derived from them: slashes and control chars become "_".
 */
function sanitizeRecordID(value: string, fallback: string): string {
  const cleaned = value.replace(/[\u0000-\u001f/]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Native Codex scanner — no codeburn dependency, JSONL only.
 * Mirrors codeburn dist/main.js:6329 token handling + fork guard + prevCumulativeTotal dedup.
 */
export async function collectCodex(request: CollectionRequest): Promise<CollectionResult> {
  assertNotAborted(request.signal);

  if (request.windows.length === 0) {
    throw new DomainError("invalid-window", "Collection request must contain at least one usage window");
  }

  const rolloutFiles = discoverRolloutFiles();

  const mutable = {
    sessionsDiscovered: rolloutFiles.length,
    sessionsScanned: 0,
    sessionsSkipped: 0,
    pagesRead: 0,
    jobsRetried: 0,
    provisionalMessages: 0,
    errors: [] as CollectionError[],
  };

  const reducer = new UsageRecordReducer();

  // Empty home → empty complete result (no error) but still compute window totals.
  if (rolloutFiles.length === 0) {
    assertNotAborted(request.signal);
    const records = reducer.records();
    const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
      request.windows.map((w) => [w.kind, sumUsageRecords(records, w)]),
    );
    const coverage: Coverage = {
      complete: true,
      sessionsDiscovered: 0,
      sessionsScanned: 0,
      sessionsSkipped: 0,
      pagesRead: 0,
      jobsRetried: 0,
      provisionalMessages: 0,
      errors: [],
    };
    return {
      capturedAt: new Date(request.capturedAt.getTime()),
      windows: request.windows.map((w) => ({
        ...w,
        from: new Date(w.from.getTime()),
        to: new Date(w.to.getTime()),
      })),
      source: "codex",
      records,
      totalsByWindow,
      coverage,
    };
  }

  for (const filePath of rolloutFiles) {
    assertNotAborted(request.signal);

    let content: string;
    try {
      // Size guard first: never load a giant rollout file into memory.
      const stat = await nodeFs.stat(filePath);
      if (stat.size > MAX_ROLLOUT_BYTES) {
        mutable.sessionsSkipped += 1;
        mutable.errors.push(
          toCollectionError(
            new DomainError("invalid-data", `Codex rollout file exceeds ${MAX_ROLLOUT_BYTES} bytes`, {
              sessionID: basename(filePath, ".jsonl"),
            }),
            "invalid-data",
            basename(filePath, ".jsonl"),
          ),
        );
        continue;
      }
      content = await nodeFs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isCancellationError(error)) {
        throw cancellationError();
      }
      mutable.sessionsSkipped += 1;
      mutable.errors.push(toCollectionError(error, "transport", basename(filePath)));
      continue;
    }
    mutable.pagesRead += 1;

    let sessionId: string | undefined;
    let sessionMetaTimestampMs: number | undefined;
    let forkCutoffMs: number | undefined;
    let prevCumulativeTotal: number | null = null;
    let prevInput = 0;
    let prevCached = 0;
    let prevCacheWrite = 0;
    let prevOutput = 0;
    let prevReasoning = 0;
    let sessionModel: string | undefined;
    let sessionProject: string | undefined;
    let fileHasError = false;

    const lines = content.split("\n");

    for (const rawLine of lines) {
      assertNotAborted(request.signal);

      const trimmed = rawLine.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(trimmed);
      } catch (error) {
        fileHasError = true;
        mutable.errors.push(
          toCollectionError(error, "invalid-data", sessionId ?? basename(filePath, ".jsonl")),
        );
        continue;
      }

      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        fileHasError = true;
        mutable.errors.push(
          toCollectionError(
            new DomainError("invalid-data", "Codex rollout line is not an object", {
              sessionID: sessionId ?? basename(filePath, ".jsonl"),
            }),
            "invalid-data",
            sessionId ?? basename(filePath, ".jsonl"),
          ),
        );
        continue;
      }

      const rec = entry as Record<string, unknown>;

      // session_meta handling — capture session_id, timestamp, forkCutoff, model
      if (rec.type === "session_meta") {
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        const sid = payload.session_id ?? (payload as Record<string, unknown>).sessionId;
        const fileFallback = sanitizeRecordID(basename(filePath, ".jsonl"), "codex-session");
        if (typeof sid === "string" && sid.trim().length > 0) {
          sessionId = sanitizeRecordID(sid, fileFallback);
        } else {
          sessionId = fileFallback;
        }

        const tsRaw = rec.timestamp;
        let tsMs: number | undefined;
        if (typeof tsRaw === "string") {
          const parsed = Date.parse(tsRaw);
          if (Number.isFinite(parsed)) {
            tsMs = parsed;
          }
        } else if (typeof tsRaw === "number" && Number.isFinite(tsRaw)) {
          tsMs = tsRaw;
        }

        if (tsMs !== undefined) {
          sessionMetaTimestampMs = tsMs;
          const forkedFromId = payload.forked_from_id ?? payload.forkedFromId;
          if (typeof forkedFromId === "string" && forkedFromId.length > 0) {
            forkCutoffMs = tsMs + 5_000;
          } else {
            forkCutoffMs = undefined;
          }
        }

        const modelRaw = payload.model;
        const modelNameRaw = payload.model_name ?? payload.modelName;
        if (typeof modelRaw === "string" && modelRaw.trim().length > 0) {
          sessionModel = modelRaw;
        } else if (typeof modelNameRaw === "string" && modelNameRaw.trim().length > 0) {
          sessionModel = modelNameRaw;
        }
        // capture cwd as project if present
        const cwdRaw = payload.cwd ?? payload.workdir ?? payload.working_directory ?? payload.directory;
        if (typeof cwdRaw === "string" && cwdRaw.trim().length > 0) {
          sessionProject = cwdRaw.trim();
        } else if (typeof (payload as Record<string, unknown>).cwd === "string") {
          const v = (payload as Record<string, unknown>).cwd as string;
          if (v.trim().length > 0) sessionProject = v.trim();
        }
        continue;
      }

      if (rec.type === "turn_context") {
        const payload = (rec.payload ?? {}) as Record<string, unknown>;
        const m = payload.model;
        if (typeof m === "string" && m.trim().length > 0) {
          sessionModel = m;
        }
        continue;
      }

      // Filter only event_msg token_count
      if (rec.type !== "event_msg") {
        continue;
      }
      const payload = (rec.payload ?? null) as Record<string, unknown> | null;
      if (payload === null || payload.type !== "token_count") {
        continue;
      }

      if (sessionId === undefined) {
        sessionId = sanitizeRecordID(basename(filePath, ".jsonl"), "codex-session");
      }
      // capture cwd from token_count payload if not yet known
      if (sessionProject === undefined) {
        const cwdCandidate = payload.cwd ?? payload.workdir ?? payload.working_directory ?? payload.directory ?? payload.workDir;
        if (typeof cwdCandidate === "string" && cwdCandidate.trim().length > 0) {
          sessionProject = cwdCandidate.trim();
        } else if (typeof (payload.info as Record<string, unknown> | null)?.cwd === "string") {
          const v = (payload.info as Record<string, unknown>).cwd as string;
          if (v.trim().length > 0) sessionProject = v.trim();
        }
      }

      // timestamp handling for fork guard and createdAt
      const tsRawEvt = rec.timestamp;
      let eventTsMs: number | undefined;
      let eventTsIso: string | undefined;
      if (typeof tsRawEvt === "string") {
        const parsed = Date.parse(tsRawEvt);
        if (Number.isFinite(parsed)) {
          eventTsMs = parsed;
          eventTsIso = tsRawEvt;
        } else {
          fileHasError = true;
          mutable.errors.push(
            toCollectionError(
              new DomainError("invalid-data", "Invalid timestamp in token_count event", {
                sessionID: sessionId,
              }),
              "invalid-data",
              sessionId,
            ),
          );
          continue;
        }
      } else if (typeof tsRawEvt === "number" && Number.isFinite(tsRawEvt)) {
        eventTsMs = tsRawEvt;
        eventTsIso = new Date(tsRawEvt).toISOString();
      } else {
        fileHasError = true;
        mutable.errors.push(
          toCollectionError(
            new DomainError("invalid-data", "Missing timestamp in token_count event", {
              sessionID: sessionId,
            }),
            "invalid-data",
            sessionId,
          ),
        );
        continue;
      }

      // Fork guard: skip if event.timestamp < session_meta.timestamp + 5s.
      // (Single check — a duplicated second check was removed; one
      // comparison against forkCutoffMs is the whole guard.)
      if (
        sessionMetaTimestampMs !== undefined &&
        forkCutoffMs !== undefined &&
        eventTsMs !== undefined &&
        eventTsMs < forkCutoffMs
      ) {
        continue;
      }

      const info = (payload.info ?? null) as Record<string, unknown> | null;
      if (info === null || typeof info !== "object" || Array.isArray(info)) {
        continue;
      }

      const totalRaw = (info.total_token_usage ?? null) as Record<string, unknown> | null;
      const lastRaw = (info.last_token_usage ?? null) as Record<string, unknown> | null;

      const cumulativeTotal = totalRaw !== null ? safeNumber(totalRaw.total_tokens) : 0;

      if (prevCumulativeTotal !== null && cumulativeTotal === prevCumulativeTotal) {
        continue;
      }
      prevCumulativeTotal = cumulativeTotal;

      let inputTokens = 0;
      let cachedInputTokens = 0;
      let cacheWriteTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;

      if (lastRaw !== null && typeof lastRaw === "object" && !Array.isArray(lastRaw)) {
        inputTokens = safeNumber((lastRaw as Record<string, unknown>).input_tokens);
        cachedInputTokens = safeNumber((lastRaw as Record<string, unknown>).cached_input_tokens);
        cacheWriteTokens = safeNumber((lastRaw as Record<string, unknown>).cache_write_input_tokens);
        outputTokens = safeNumber((lastRaw as Record<string, unknown>).output_tokens);
        reasoningTokens = safeNumber((lastRaw as Record<string, unknown>).reasoning_output_tokens);
      } else if (cumulativeTotal > 0 && totalRaw !== null) {
        const totalInput = safeNumber(totalRaw.input_tokens);
        const totalCached = safeNumber(totalRaw.cached_input_tokens);
        const totalCacheWrite = safeNumber(totalRaw.cache_write_input_tokens);
        const totalOutput = safeNumber(totalRaw.output_tokens);
        const totalReasoning = safeNumber(totalRaw.reasoning_output_tokens);

        inputTokens = totalInput - prevInput;
        cachedInputTokens = totalCached - prevCached;
        cacheWriteTokens = totalCacheWrite - prevCacheWrite;
        outputTokens = totalOutput - prevOutput;
        reasoningTokens = totalReasoning - prevReasoning;

        if (inputTokens < 0) inputTokens = 0;
        if (cachedInputTokens < 0) cachedInputTokens = 0;
        if (cacheWriteTokens < 0) cacheWriteTokens = 0;
        if (outputTokens < 0) outputTokens = 0;
        if (reasoningTokens < 0) reasoningTokens = 0;
      } else {
        // No last_token_usage and no usable total delta → still need to update prev* below
        // Fall through to update prev* then skip record generation
      }

      // Update prev* from total_token_usage for next delta (codeburn does this unconditionally)
      if (totalRaw !== null && typeof totalRaw === "object" && !Array.isArray(totalRaw)) {
        const t = totalRaw as Record<string, unknown>;
        if (typeof t.input_tokens === "number" && Number.isFinite(t.input_tokens)) prevInput = t.input_tokens;
        if (typeof t.cached_input_tokens === "number" && Number.isFinite(t.cached_input_tokens))
          prevCached = t.cached_input_tokens;
        if (typeof t.cache_write_input_tokens === "number" && Number.isFinite(t.cache_write_input_tokens))
          prevCacheWrite = t.cache_write_input_tokens;
        if (typeof t.output_tokens === "number" && Number.isFinite(t.output_tokens)) prevOutput = t.output_tokens;
        if (typeof t.reasoning_output_tokens === "number" && Number.isFinite(t.reasoning_output_tokens))
          prevReasoning = t.reasoning_output_tokens;
      }

      const totalTokens = inputTokens + cachedInputTokens + outputTokens + reasoningTokens;
      if (totalTokens === 0) {
        continue;
      }

      const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
      const cacheWriteInputTokens = Math.max(0, Math.min(cacheWriteTokens, uncachedInputTokens));
      const billedCacheWriteTokens = cacheWriteInputTokens;
      const billedInputTokens = uncachedInputTokens - billedCacheWriteTokens;

      // Resolve model
      let model = sessionModel ?? "unknown";
      const payloadModel = payload.model ?? payload.model_name ?? (info as Record<string, unknown>).model ?? (info as Record<string, unknown>).model_name;
      if (typeof payloadModel === "string" && payloadModel.trim().length > 0) {
        model = payloadModel;
      } else if (typeof (payload as Record<string, unknown>).model === "string") {
        model = (payload as Record<string, unknown>).model as string;
      }

      let createdAt: Date;
      try {
        createdAt = new Date(eventTsIso ?? "");
        if (Number.isNaN(createdAt.getTime())) {
          if (eventTsMs !== undefined) createdAt = new Date(eventTsMs);
          else throw new Error("invalid timestamp");
        }
        if (Number.isNaN(createdAt.getTime())) {
          throw new Error("invalid timestamp");
        }
      } catch (error) {
        fileHasError = true;
        mutable.errors.push(toCollectionError(error, "invalid-data", sessionId));
        continue;
      }

      // Window filter
      const inWindow = request.windows.some((w) => containsInstant(w, createdAt));
      if (!inWindow) {
        continue;
      }

      // dedupKey = codex:{sessionId}:{total.total_tokens}:{total.input}:{total.cached}:{total.output}:{total.reasoning}
      // sessionId is already sanitized, but sanitize the composed key too:
      // messageID rejects "/" at the domain boundary, so any stray slash
      // (e.g. from a hostile session_id) must never reach createUsageRecord.
      const totalInputForKey =
        totalRaw !== null && typeof totalRaw.input_tokens === "number" ? totalRaw.input_tokens : 0;
      const totalCachedForKey =
        totalRaw !== null && typeof totalRaw.cached_input_tokens === "number"
          ? totalRaw.cached_input_tokens
          : 0;
      const totalOutputForKey =
        totalRaw !== null && typeof totalRaw.output_tokens === "number" ? totalRaw.output_tokens : 0;
      const totalReasoningForKey =
        totalRaw !== null && typeof totalRaw.reasoning_output_tokens === "number"
          ? totalRaw.reasoning_output_tokens
          : 0;
      const dedupKey = sanitizeRecordID(
        `codex:${sessionId}:${cumulativeTotal}:${totalInputForKey}:${totalCachedForKey}:${totalOutputForKey}:${totalReasoningForKey}`,
        `codex:${sessionId}:${cumulativeTotal}`,
      );

      try {
        const record: UsageRecord = createUsageRecord({
          sessionID: sessionId,
          messageID: dedupKey,
          createdAt,
          model,
          tokens: {
            input: billedInputTokens,
            output: outputTokens,
            reasoning: reasoningTokens,
            cacheRead: cachedInputTokens,
            cacheWrite: billedCacheWriteTokens,
          },
          observedAt: new Date(request.capturedAt.getTime()),
          completeness: "final",
          provider: "codex",
          tokenRevision: dedupKey,
          ...(sessionProject === undefined ? {} : { project: sessionProject }),
        });
        reducer.upsert(record);
      } catch (error) {
        fileHasError = true;
        mutable.errors.push(toCollectionError(error, "invalid-data", sessionId));
      }
    }

    if (fileHasError) {
      mutable.sessionsSkipped += 1;
    } else {
      mutable.sessionsScanned += 1;
    }
  }

  assertNotAborted(request.signal);

  const records = reducer.records();

  const totalsByWindow: UsageTotalsByWindow = Object.fromEntries(
    request.windows.map((w) => [w.kind, sumUsageRecords(records, w)]),
  );

  const providersMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};
  const modelsMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};
  const projectsMutable: Record<string, ReadonlyArray<UsageBreakdown>> = {};

  for (const w of request.windows) {
    const windowRecords = records.filter((r) => containsInstant(w, r.createdAt));
    if (windowRecords.length === 0) {
      continue;
    }
    const codexTotals = sumUsageRecords(windowRecords, w);
    providersMutable[w.kind] = [{ name: "codex", provider: "codex", totals: codexTotals }];

    const byModel = new Map<string, UsageRecord[]>();
    for (const r of windowRecords) {
      const key = r.model;
      const arr = byModel.get(key);
      if (arr === undefined) byModel.set(key, [r]);
      else arr.push(r);
    }
    const modelBreakdowns: UsageBreakdown[] = [];
    for (const [modelName, recs] of byModel.entries()) {
      const totals = sumUsageRecords(recs, w);
      modelBreakdowns.push({ name: modelName, totals });
    }
    modelBreakdowns.sort((a, b) => b.totals.recorded_total - a.totals.recorded_total);
    if (modelBreakdowns.length > 0) {
      modelsMutable[w.kind] = modelBreakdowns;
    }

    // projects breakdown per window for codex (based on extracted cwd)
    const byProject = new Map<string, UsageRecord[]>();
    for (const r of windowRecords) {
      if (r.project === undefined || r.project.trim().length === 0) continue;
      const key = r.project;
      const arr = byProject.get(key);
      if (arr === undefined) byProject.set(key, [r]);
      else arr.push(r);
    }
    if (byProject.size > 0) {
      const projectBreakdowns: UsageBreakdown[] = [];
      for (const [projName, recs] of byProject.entries()) {
        const totals = sumUsageRecords(recs, w);
        projectBreakdowns.push({ name: projName, totals });
      }
      projectBreakdowns.sort((a, b) => b.totals.recorded_total - a.totals.recorded_total || a.name.localeCompare(b.name));
      projectsMutable[w.kind] = projectBreakdowns;
    }
  }

  const providersByWindow: UsageBreakdownsByWindow = providersMutable;
  const modelsByWindow: UsageBreakdownsByWindow = modelsMutable;
  const projectsByWindow: UsageBreakdownsByWindow = projectsMutable;

  const finalCoverage: Coverage = {
    complete: mutable.errors.length === 0 && mutable.sessionsSkipped === 0,
    sessionsDiscovered: mutable.sessionsDiscovered,
    sessionsScanned: mutable.sessionsScanned,
    sessionsSkipped: mutable.sessionsSkipped,
    pagesRead: mutable.pagesRead,
    jobsRetried: mutable.jobsRetried,
    provisionalMessages: mutable.provisionalMessages,
    errors: sortedErrors(mutable.errors),
  };

  const maybeModels =
    Object.keys(modelsByWindow).length > 0
      ? { modelsByWindow, models: [...(modelsByWindow.week ?? modelsByWindow.day ?? modelsByWindow.hour ?? Object.values(modelsByWindow).flat())] }
      : {};
  const maybeProviders =
    Object.keys(providersByWindow).length > 0
      ? { providersByWindow, providers: [...(providersByWindow.week ?? providersByWindow.day ?? providersByWindow.hour ?? Object.values(providersByWindow).flat())] }
      : {};
  const maybeProjects =
    Object.keys(projectsByWindow).length > 0
      ? { projectsByWindow, projects: [...(projectsByWindow.week ?? projectsByWindow.day ?? projectsByWindow.hour ?? Object.values(projectsByWindow).flat())] }
      : {};

  return {
    capturedAt: new Date(request.capturedAt.getTime()),
    windows: request.windows.map((w) => ({
      ...w,
      from: new Date(w.from.getTime()),
      to: new Date(w.to.getTime()),
    })),
    source: "codex",
    records,
    totalsByWindow,
    ...maybeModels,
    ...maybeProviders,
    ...maybeProjects,
    coverage: finalCoverage,
  };
}
