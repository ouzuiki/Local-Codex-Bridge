import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryCoreClient } from "../src/memory-core-client.js";

type RecordedCall = {
  url: string;
  init: RequestInit | undefined;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(error: unknown): string {
  assert.ok(error instanceof Error);
  return error.message;
}

test("maps verified L0 add/search/delete operations exactly", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/v3/conversation/add")) {
      return jsonResponse({ code: 0, data: { accepted_ids: ["msg-1", "msg-2"] } });
    }
    if (url.endsWith("/v3/conversation/search")) {
      return jsonResponse({
        code: 0,
        data: {
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "marker",
              timestamp: "2026-08-30T00:00:00Z",
              score: 0.5,
            },
            { id: "msg-2", role: "assistant", content: "reply" },
          ],
        },
      });
    }
    if (url.endsWith("/v3/conversation/delete")) {
      return jsonResponse({ code: 0, data: { deleted_count: 2 } });
    }
    throw new Error("unexpected URL");
  }) as typeof fetch;

  const client = new MemoryCoreClient({
    baseUrl: "http://memory.test///",
    serviceId: "test-service",
    gatewayKey: "fake-secret",
    fetchImpl,
  });
  const scope = {
    teamId: "team",
    agentId: "agent",
    userId: "user",
    sessionId: "session",
  };

  assert.equal(client.baseUrl, "http://memory.test");
  assert.equal(client.serviceId, "test-service");

  assert.deepEqual(
    await client.conversationAdd({
      ...scope,
      messages: [
        { role: "user", content: "marker" },
        { role: "assistant", content: "reply" },
      ],
    }),
    { acceptedIds: ["msg-1", "msg-2"] },
  );

  assert.deepEqual(await client.conversationSearch({ ...scope, query: "marker" }), {
    messages: [
      {
        id: "msg-1",
        role: "user",
        content: "marker",
        timestamp: "2026-08-30T00:00:00Z",
        score: 0.5,
      },
      { id: "msg-2", role: "assistant", content: "reply" },
    ],
  });

  assert.deepEqual(
    await client.conversationDelete({ ...scope, messageIds: ["msg-1", "msg-2"] }),
    { deletedCount: 2 },
  );

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://memory.test/v3/conversation/add",
      "http://memory.test/v3/conversation/search",
      "http://memory.test/v3/conversation/delete",
    ],
  );

  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(call.init?.method, "POST");
    assert.equal(headers.get("Authorization"), "Bearer fake-secret");
    assert.equal(headers.get("x-tdai-service-id"), "test-service");
    assert.equal(headers.get("Content-Type"), "application/json");
  }

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    team_id: "team",
    agent_id: "agent",
    user_id: "user",
    session_id: "session",
    messages: [
      { role: "user", content: "marker" },
      { role: "assistant", content: "reply" },
    ],
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    team_id: "team",
    agent_id: "agent",
    user_id: "user",
    session_id: "session",
    query: "marker",
    limit: 20,
  });
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    team_id: "team",
    agent_id: "agent",
    user_id: "user",
    session_id: "session",
    message_ids: ["msg-1", "msg-2"],
  });
});

test("validates key and search limit before fetch", async () => {
  assert.throws(
    () => new MemoryCoreClient({ gatewayKey: "   " }),
    /gatewayKey must be a nonblank string/,
  );

  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return jsonResponse({ code: 0, data: { messages: [] } });
  }) as typeof fetch;
  const client = new MemoryCoreClient({ gatewayKey: "fake-secret", fetchImpl });

  await assert.rejects(
    client.conversationSearch({
      teamId: "team",
      agentId: "agent",
      userId: "user",
      sessionId: "session",
      query: "marker",
      limit: 0,
    }),
    /limit must be an integer from 1 to 100/,
  );
  assert.equal(fetchCalls, 0);
});

test("sanitizes HTTP and API errors without leaking secrets or raw bodies", async () => {
  const secret = "FAKE-SUPER-SECRET";
  const rawMarker = "RAW-BODY-MUST-NOT-LEAK";
  const scope = {
    teamId: "team",
    agentId: "agent",
    userId: "user",
    sessionId: "session",
    query: "marker",
  };

  const httpClient = new MemoryCoreClient({
    gatewayKey: secret,
    fetchImpl: (async () =>
      new Response(`${rawMarker}:${secret}`, { status: 503 })) as typeof fetch,
  });
  const httpError = await httpClient.conversationSearch(scope).then(
    () => new Error("expected rejection"),
    (error: unknown) => error,
  );
  const httpText = errorMessage(httpError);
  assert.equal(httpText, "MemoryCore conversationSearch HTTP 503");
  assert.equal(httpText.includes(secret), false);
  assert.equal(httpText.includes(rawMarker), false);

  const apiClient = new MemoryCoreClient({
    gatewayKey: secret,
    fetchImpl: (async () =>
      jsonResponse({ code: 77, message: `${rawMarker}:${secret}`, data: null })) as typeof fetch,
  });
  const apiError = await apiClient.conversationSearch(scope).then(
    () => new Error("expected rejection"),
    (error: unknown) => error,
  );
  const apiText = errorMessage(apiError);
  assert.equal(apiText, "MemoryCore conversationSearch API code 77");
  assert.equal(apiText.includes(secret), false);
  assert.equal(apiText.includes(rawMarker), false);
});

test("maps atomic search URL, headers, default limit, options, and response", async () => {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      code: 0,
      data: {
        items: [
          {
            id: "atomic-1",
            content: "remember this",
            type: "fact",
            background: "context",
            version: 3,
            score: 0.9,
            created_at: "2026-08-30T00:00:00Z",
            updated_at: "2026-08-30T01:00:00Z",
            team_id: "team",
            user_id: "user",
            agent_id: "agent",
            task_id: "task-1",
            ignored: "not allowed",
          },
          { id: "atomic-2", content: "second", score: 0.5 },
        ],
      },
    });
  }) as typeof fetch;
  const client = new MemoryCoreClient({
    baseUrl: "http://memory.test/",
    serviceId: "test-service",
    gatewayKey: "fake-secret",
    fetchImpl,
  });
  const scope = { teamId: "team", agentId: "agent", userId: "user", sessionId: "session" };

  const defaultResult = await client.atomicSearch({ ...scope, query: "needle" });
  await client.atomicSearch({ ...scope, query: "needle", limit: 5, type: "fact" });

  assert.deepEqual(defaultResult, {
    items: [
      {
        id: "atomic-1",
        content: "remember this",
        type: "fact",
        background: "context",
        version: 3,
        score: 0.9,
        created_at: "2026-08-30T00:00:00Z",
        updated_at: "2026-08-30T01:00:00Z",
        team_id: "team",
        user_id: "user",
        agent_id: "agent",
        task_id: "task-1",
      },
      { id: "atomic-2", content: "second", score: 0.5 },
    ],
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "http://memory.test/v3/atomic/search");
    assert.equal(call.init?.method, "POST");
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer fake-secret");
    assert.equal(headers.get("x-tdai-service-id"), "test-service");
    assert.equal(headers.get("Content-Type"), "application/json");
  }
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    team_id: "team",
    agent_id: "agent",
    user_id: "user",
    session_id: "session",
    query: "needle",
    limit: 20,
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    team_id: "team",
    agent_id: "agent",
    user_id: "user",
    session_id: "session",
    query: "needle",
    limit: 5,
    type: "fact",
  });
});

test("validates atomic search limit and nonblank string inputs before fetch", async () => {
  let fetchCalls = 0;
  const client = new MemoryCoreClient({
    gatewayKey: "fake-secret",
    fetchImpl: (async () => {
      fetchCalls += 1;
      return jsonResponse({ code: 0, data: { items: [] } });
    }) as typeof fetch,
  });
  const scope = { teamId: "team", agentId: "agent", userId: "user", sessionId: "session" };
  const invalidInputs = [
    { ...scope, query: "needle", limit: 0 },
    { ...scope, query: "needle", limit: 101 },
    { ...scope, query: "needle", limit: 1.5 },
    { ...scope, query: "   " },
    { ...scope, query: "needle", type: "   " },
    { ...scope, query: "needle", teamId: "   " },
    { ...scope, query: "needle", agentId: "   " },
    { ...scope, query: "needle", userId: "   " },
    { ...scope, query: "needle", sessionId: "   " },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(client.atomicSearch(input));
  }
  assert.equal(fetchCalls, 0);
});

test("sanitizes atomic search HTTP and API errors", async () => {
  const secret = "FAKE-ATOMIC-SECRET";
  const rawMarker = "RAW-ATOMIC-BODY";
  const input = {
    teamId: "team",
    agentId: "agent",
    userId: "user",
    sessionId: "session",
    query: "needle",
  };
  const httpClient = new MemoryCoreClient({
    gatewayKey: secret,
    fetchImpl: (async () => new Response(`${rawMarker}:${secret}`, { status: 502 })) as typeof fetch,
  });
  const httpError = await httpClient.atomicSearch(input).then(
    () => new Error("expected rejection"),
    (error: unknown) => error,
  );
  assert.equal(errorMessage(httpError), "MemoryCore atomicSearch HTTP 502");
  assert.equal(errorMessage(httpError).includes(secret), false);
  assert.equal(errorMessage(httpError).includes(rawMarker), false);

  const apiClient = new MemoryCoreClient({
    gatewayKey: secret,
    fetchImpl: (async () =>
      jsonResponse({ code: 88, message: `${rawMarker}:${secret}`, data: null })) as typeof fetch,
  });
  const apiError = await apiClient.atomicSearch(input).then(
    () => new Error("expected rejection"),
    (error: unknown) => error,
  );
  assert.equal(errorMessage(apiError), "MemoryCore atomicSearch API code 88");
  assert.equal(errorMessage(apiError).includes(secret), false);
  assert.equal(errorMessage(apiError).includes(rawMarker), false);
});
