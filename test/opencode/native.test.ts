import assert from "node:assert/strict";
import test from "node:test";
import { createUsageWindow } from "../../src/domain/index.js";
import {
  connectOpenCode,
  createNativeClient,
  OpenCode2Transport,
  parseOpenCodeHealth,
} from "../../src/opencode/index.js";
import type { Endpoint } from "@opencode-ai/client/service";

const endpoint: Endpoint = { url: "http://127.0.0.1:9999" };
const window = () => createUsageWindow("hour", new Date("2026-01-02T03:04:05.000Z"), "UTC");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("parses the 2.0.6 /api/info health shape without a healthy flag", () => {
  const health = parseOpenCodeHealth({ version: "2.0.6", pid: 123, urls: ["http://x"], paths: { tmp: "/tmp" } }, endpoint);
  assert.equal(health.version, "2.0.6");
  assert.equal(health.fingerprint.length, 24);
});

test("still parses the legacy /api/health shape", () => {
  const health = parseOpenCodeHealth({ healthy: true, version: "beta", pid: 1 }, endpoint);
  assert.equal(health.version, "beta");
});

test("rejects a degraded healthy:false payload", () => {
  assert.throws(() => parseOpenCodeHealth({ healthy: false, version: "x" }, endpoint));
});

test("transport getHealth accepts the /api/info shape", async () => {
  const transport = new OpenCode2Transport({
    client: {
      health: { get: async () => ({ version: "2.0.6", pid: 99 }) },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        stats: async () => ({ range: { from: 0, to: 1 }, tokens: {} }),
      },
      message: { list: async () => ({ data: [], cursor: { next: null } }) },
    },
    maxAttempts: 1,
  });
  const health = await transport.getHealth();
  assert.equal(health.version, "2.0.6");
});

test("native client reads stats from the experimental endpoint", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    seen.push(href);
    if (href.includes("/api/experimental/session/stats")) {
      const w = window();
      return jsonResponse({
        data: {
          range: { from: w.from.getTime(), to: w.to.getTime() },
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          models: [],
        },
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  const client = createNativeClient(endpoint, { fetch: fetchImpl });
  const transport = new OpenCode2Transport({ client, maxAttempts: 1 });
  const stats = await transport.getSessionStats(window());
  assert.equal(stats.totals.recorded_total, 15);
  assert.ok(seen.some((u) => u.includes("/api/experimental/session/stats")));
});

test("native client falls back to the legacy stats endpoint on 404", async () => {
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/api/experimental/session/stats")) return jsonResponse({}, 404);
    if (href.includes("/api/session/stats")) {
      const w = window();
      return jsonResponse({
        range: { from: w.from.getTime(), to: w.to.getTime() },
        tokens: { input: 7 },
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  const client = createNativeClient(endpoint, { fetch: fetchImpl });
  const transport = new OpenCode2Transport({ client, maxAttempts: 1 });
  const stats = await transport.getSessionStats(window());
  assert.equal(stats.totals.input, 7);
});

test("native client paginates sessions and messages on 2.0.6 routes", async () => {
  const now = Date.now();
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/message")) {
      return jsonResponse({
        data: [
          {
            type: "assistant",
            id: "a1",
            time: { created: now, completed: now + 1 },
            model: { providerID: "p", id: "m" },
            tokens: { input: 7 },
          },
        ],
        cursor: { previous: null, next: null },
      });
    }
    return jsonResponse({ data: [{ id: "ses_abc", projectID: "p1" }], cursor: { previous: null, next: null } });
  }) as typeof fetch;

  const client = createNativeClient(endpoint, { fetch: fetchImpl });
  const transport = new OpenCode2Transport({ client, maxAttempts: 1 });
  const sessions = await transport.listSessions();
  assert.equal(sessions.sessions[0]?.sessionID, "ses_abc");
  const messages = await transport.listMessages({ sessionID: "ses_abc" });
  assert.equal(messages.messages.length, 1);
  assert.equal(messages.messages[0]?.model, "p/m");
});

test("connectOpenCode accepts the /api/info shape from an injected client", async () => {
  const connection = await connectOpenCode({
    service: {
      discover: async () => endpoint,
      ensure: async () => endpoint,
      headers: () => undefined,
    },
    client: {
      health: { get: async () => ({ version: "2.0.6", pid: 321 }) },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        stats: async () => ({ range: { from: 0, to: 1 }, tokens: {} }),
      },
      message: { list: async () => ({ data: [], cursor: { next: null } }) },
    },
  });
  assert.equal(connection.health.version, "2.0.6");
  assert.equal(connection.health.fingerprint.length, 24);
});
