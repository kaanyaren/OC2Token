import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainError,
  createUsageWindow,
} from "../../src/domain/index.js";
import {
  OpenCode2Transport,
  connectOpenCode,
  isStatsRangeMismatch,
  type OpenCodeClientLike,
} from "../../src/opencode/index.js";

const endpointNow = new Date("2026-01-02T03:04:05.000Z");

function window() {
  return createUsageWindow("hour", endpointNow, "UTC");
}

function client(overrides: Partial<{
  health: (...args: any[]) => Promise<unknown>;
  stats: (...args: any[]) => Promise<unknown>;
  sessions: (...args: any[]) => Promise<unknown>;
  messages: (...args: any[]) => Promise<unknown>;
}> = {}): OpenCodeClientLike {
  return {
    health: { get: overrides.health ?? (async () => ({ healthy: true, version: "beta", pid: 1 })) },
    session: {
      stats: overrides.stats ?? (async () => ({
        range: { from: window().from.getTime(), to: window().to.getTime() },
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
      })),
      list: overrides.sessions ?? (async () => ({ data: [], cursor: { next: null } })),
    },
    message: { list: overrides.messages ?? (async () => ({ data: [], cursor: { next: null } })) },
  };
}

test("collects typed stats with exact bounded query parameters", async () => {
  let input: Record<string, unknown> | undefined;
  const transport = new OpenCode2Transport({
    client: client({ stats: async (received) => {
      input = received;
      return {
        range: { from: window().from.getTime(), to: window().to.getTime() },
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
      };
    } }),
    jitter: 0,
    sleep: async () => undefined,
  });

  const result = await transport.getSessionStats(window(), { project: "project-1" });
  assert.deepEqual(input, {
    from: window().from.getTime(),
    to: window().to.getTime(),
    project: "project-1",
    timezone: "UTC",
    tools: "none",
  });
  assert.deepEqual(result.totals, {
    input: 2,
    output: 3,
    reasoning: 4,
    cacheRead: 5,
    cacheWrite: 6,
    recorded_total: 20,
  });
});

test("rejects an ignored or broader stats range", async () => {
  const transport = new OpenCode2Transport({
    client: client({ stats: async () => ({
      range: { from: window().from.getTime() - 1, to: window().to.getTime() + 1 },
      tokens: { input: 1 },
    }) }),
    maxAttempts: 1,
  });

  await assert.rejects(
    transport.getSessionStats(window()),
    (error: unknown) => isStatsRangeMismatch(error) && error.broader,
  );

  const malformed = new OpenCode2Transport({
    client: client({ stats: async () => ({ tokens: { input: 1 } }) }),
    maxAttempts: 2,
  });
  await assert.rejects(malformed.getSessionStats(window()), (error: unknown) =>
    error instanceof DomainError && error.code === "invalid-data",
  );
});

test("retries 429 reads but does not retry authentication failures", async () => {
  let attempts = 0;
  const transport = new OpenCode2Transport({
    client: client({ stats: async () => {
      attempts += 1;
      if (attempts === 1) throw { status: 429 };
      return {
        range: { from: window().from.getTime(), to: window().to.getTime() },
        tokens: { input: 1 },
      };
    } }),
    maxAttempts: 2,
    baseDelayMs: 0,
    jitter: 0,
    sleep: async () => undefined,
  });
  await transport.getSessionStats(window());
  assert.equal(attempts, 2);

  attempts = 0;
  const unavailable = new OpenCode2Transport({
    client: client({ stats: async () => {
      attempts += 1;
      if (attempts === 1) throw { status: 503 };
      return {
        range: { from: window().from.getTime(), to: window().to.getTime() },
        tokens: { output: 1 },
      };
    } }),
    maxAttempts: 2,
    baseDelayMs: 0,
    jitter: 0,
    sleep: async () => undefined,
  });
  await unavailable.getSessionStats(window());
  assert.equal(attempts, 2);

  attempts = 0;
  const unauthorized = new OpenCode2Transport({
    client: client({ stats: async () => {
      attempts += 1;
      throw { status: 401 };
    } }),
    maxAttempts: 3,
    sleep: async () => undefined,
  });
  await assert.rejects(unauthorized.getSessionStats(window()), (error: unknown) =>
    error instanceof DomainError && error.code === "authentication",
  );
  assert.equal(attempts, 1);

  attempts = 0;
  const forbidden = new OpenCode2Transport({
    client: client({ stats: async () => {
      attempts += 1;
      throw { status: 403 };
    } }),
    maxAttempts: 3,
  });
  await assert.rejects(forbidden.getSessionStats(window()), (error: unknown) =>
    error instanceof DomainError && error.code === "authentication",
  );
  assert.equal(attempts, 1);
});

test("maps paginated OpenCode envelopes without retaining message content", async () => {
  const calls: string[] = [];
  const transport = new OpenCode2Transport({
    client: client({
      sessions: async (input) => ({
        data: [{ id: input.cursor === undefined ? "root" : "child", parentID: input.cursor === undefined ? undefined : "root", title: "private" }],
        cursor: { next: input.cursor === undefined ? "next" : null },
      }),
      messages: async (input) => {
        calls.push(input.cursor ?? "first");
        return {
          data: [
            { type: "user", id: "u1", time: { created: endpointNow.getTime() }, text: "secret" },
            { type: "assistant", id: "a1", time: { created: endpointNow.getTime(), completed: endpointNow.getTime() + 1 }, model: { providerID: "p", id: "m" }, tokens: { input: 7 } },
          ],
          cursor: { next: null },
        };
      },
    }),
    maxAttempts: 1,
  });

  const sessions = await transport.listAllSessions();
  const messages = await transport.listAllMessages({ sessionID: "root" });
  assert.deepEqual(sessions.map((item) => item.sessionID), ["root", "child"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.model, "p/m");
  assert.deepEqual(messages[0]?.tokens, { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(calls, ["first"]);
});

test("turns request deadlines and caller aborts into bounded typed failures", async () => {
  const pending = new Promise<unknown>(() => undefined);
  const timeoutTransport = new OpenCode2Transport({
    client: client({ stats: async () => pending }),
    maxAttempts: 1,
    requestTimeoutMs: 5,
  });
  await assert.rejects(timeoutTransport.getSessionStats(window()), (error: unknown) =>
    error instanceof DomainError && error.code === "transport" && error.retryable,
  );

  const controller = new AbortController();
  const abortTransport = new OpenCode2Transport({
    client: client({ stats: async () => pending }),
    maxAttempts: 3,
    requestTimeoutMs: 1_000,
  });
  const request = abortTransport.getSessionStats(window(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof DomainError && error.code === "cancelled");
});

test("uses injected Service.discover/ensure and reports health metadata", async () => {
  let discovered = 0;
  let ensured = 0;
  let command: readonly string[] | undefined;
  const connection = await connectOpenCode({
    service: {
      discover: async () => {
        discovered += 1;
        return undefined;
      },
      ensure: async (options) => {
        ensured += 1;
        command = options?.command;
        return { url: "http://127.0.0.1:4096", auth: undefined };
      },
      headers: () => undefined,
    },
    clientFactory: () => client(),
  });
  assert.equal(discovered, 1);
  assert.equal(ensured, 1);
  assert.deepEqual(command, ["opencode2", "serve", "--service"]);
  assert.equal(connection.health.version, "beta");
  assert.equal(connection.health.fingerprint.length, 24);
});
