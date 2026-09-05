import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";
import {
  DARWIN_PLATFORM_POLICY,
  WINDOWS_PLATFORM_POLICY,
} from "../src/platform.js";

interface CapturedRequest {
  method: string;
  params: unknown;
}

class StubAppServerManager extends AppServerManager {
  readonly requests: CapturedRequest[] = [];

  constructor(
    private readonly handleRequest: (method: string, params: unknown) => unknown,
  ) {
    super(new RuntimeStore(), { executable: "unused-test-codex" });
  }

  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handleRequest(method, params);
  }
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function propertySchema(toolName: string, propertyName: string): Record<string, unknown> {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === toolName);
  assert.ok(tool, `missing tool definition ${toolName}`);
  const properties = object(tool.inputSchema.properties);
  return object(properties[propertyName]);
}

function setAutoRecallEnv(t: test.TestContext, values: Record<string, string | undefined>): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function turnManager(): StubAppServerManager {
  return new StubAppServerManager((method) => {
    if (method === "thread/start" || method === "thread/resume") {
      return { thread: { id: method === "thread/resume" ? "thread-existing" : "thread-new" } };
    }
    if (method === "turn/start") return { turn: { id: "turn-new", status: "inProgress" } };
    throw new Error(`unexpected request ${method}`);
  });
}

function forwardedTurnText(manager: StubAppServerManager): string {
  const request = manager.requests.find((candidate) => candidate.method === "turn/start");
  assert.ok(request);
  const input = object(request.params).input;
  assert.ok(Array.isArray(input));
  return String(object(input[0]).text);
}

test("codex_turn forwards each requested raw sandbox and the exact returned native policy", async (t) => {
  const cases = [
    {
      requested: "read-only",
      policy: { type: "readOnly" },
    },
    {
      requested: "workspace-write",
      policy: {
        type: "workspaceWrite",
        writableRoots: ["D:\\work", "D:\\shared"],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      },
    },
    {
      requested: "danger-full-access",
      policy: { type: "dangerFullAccess" },
    },
  ] as const;

  for (const { requested, policy } of cases) {
    await t.test(requested, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method === "thread/start") {
          return { thread: { id: `thread-${requested}` }, sandbox: policy };
        }
        if (method === "turn/start") {
          return { turn: { id: `turn-${requested}`, status: "inProgress" } };
        }
        throw new Error(`unexpected request ${method}`);
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await surface.call("codex_turn", {
        text: "test turn",
        cwd: "D:\\work",
        sandbox: requested,
      });

      assert.equal(manager.requests.length, 2);
      assert.equal(manager.requests[0]?.method, "thread/start");
      assert.deepEqual(object(manager.requests[0]?.params), {
        cwd: "D:\\work",
        sandbox: requested,
        serviceName: "local-codex-bridge",
      });
      assert.equal(manager.requests[1]?.method, "turn/start");
      const turnParams = object(manager.requests[1]?.params);
      assert.strictEqual(turnParams.sandboxPolicy, policy);
      assert.deepEqual(turnParams.sandboxPolicy, policy);
    });
  }
});

test("codex_turn uses the newly resolved policy when the same thread changes sandbox", async () => {
  const workspacePolicy = {
    type: "workspaceWrite",
    writableRoots: ["D:\\work"],
    networkAccess: false,
  };
  const readOnlyPolicy = { type: "readOnly" };
  let turnNumber = 0;
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-shared" }, sandbox: workspacePolicy };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-shared" }, sandbox: readOnlyPolicy };
    }
    if (method === "turn/start") {
      turnNumber += 1;
      return { turn: { id: `turn-${turnNumber}`, status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "first",
    cwd: "D:\\work",
    sandbox: "workspace-write",
  });
  await surface.call("codex_turn", {
    text: "second",
    thread_id: "thread-shared",
    sandbox: "read-only",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "thread/start",
    "turn/start",
    "thread/resume",
    "turn/start",
  ]);
  assert.strictEqual(object(manager.requests[1]?.params).sandboxPolicy, workspacePolicy);
  assert.deepEqual(object(manager.requests[2]?.params), {
    threadId: "thread-shared",
    sandbox: "read-only",
  });
  assert.strictEqual(object(manager.requests[3]?.params).sandboxPolicy, readOnlyPolicy);
});

test("codex_turn omission requires no effective sandbox or approval-policy readback", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return {
        thread: { id: "thread-default" },
        sandbox: { type: "workspaceWrite", writableRoots: ["D:\\work"] },
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-default", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", { text: "default sandbox", cwd: "D:\\work" });

  assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start", "turn/start"]);
  assert.equal("sandbox" in object(manager.requests[0]?.params), false);
  assert.equal("approvalPolicy" in object(manager.requests[0]?.params), false);
  assert.equal("sandboxPolicy" in object(manager.requests[1]?.params), false);
  assert.equal("approvalPolicy" in object(manager.requests[1]?.params), false);
});

test("codex_turn verifies and forwards matching native effective approval policies", async (t) => {
  const approvalPolicies = ["untrusted", "on-request", "never"] as const;

  for (const approvalPolicy of approvalPolicies) {
    await t.test(approvalPolicy, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method === "thread/start") {
          return {
            thread: { id: `thread-${approvalPolicy}` },
            approvalPolicy,
          };
        }
        if (method === "turn/start") {
          return { turn: { id: `turn-${approvalPolicy}`, status: "inProgress" } };
        }
        throw new Error(`unexpected request ${method}`);
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await surface.call("codex_turn", {
        text: "explicit approval policy",
        cwd: "D:\\work",
        approval_policy: approvalPolicy,
      });

      assert.deepEqual(manager.requests.map((request) => request.method), [
        "thread/start",
        "turn/start",
      ]);
      assert.equal(object(manager.requests[0]?.params).approvalPolicy, approvalPolicy);
      assert.equal(object(manager.requests[1]?.params).approvalPolicy, approvalPolicy);
    });
  }
});

test("codex_turn verifies the effective approval policy returned by thread/resume", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/resume") {
      return { thread: { id: "thread-existing-approval" }, approvalPolicy: "never" };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-existing-approval", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "explicit resumed approval policy",
    thread_id: "thread-existing-approval",
    approval_policy: "never",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "thread/resume",
    "turn/start",
  ]);
  assert.equal(object(manager.requests[0]?.params).approvalPolicy, "never");
  assert.equal(object(manager.requests[1]?.params).approvalPolicy, "never");
});

test("codex_turn fails before turn/start for unusable or mismatched effective approval policies", async (t) => {
  const invalidPolicies: Array<{
    name: string;
    includeApprovalPolicy: boolean;
    value?: unknown;
  }> = [
    { name: "missing", includeApprovalPolicy: false },
    { name: "non-string", includeApprovalPolicy: true, value: 17 },
    {
      name: "granular object",
      includeApprovalPolicy: true,
      value: { granular: { commandExecution: "on-request" } },
    },
    { name: "compatibility alias", includeApprovalPolicy: true, value: "on-failure" },
    { name: "unrecognized", includeApprovalPolicy: true, value: "future-policy" },
    { name: "mismatched", includeApprovalPolicy: true, value: "on-request" },
  ];

  for (const invalid of invalidPolicies) {
    await t.test(invalid.name, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method !== "thread/start") {
          throw new Error(`unexpected request ${method}`);
        }
        return {
          thread: { id: "thread-invalid-approval" },
          ...(invalid.includeApprovalPolicy ? { approvalPolicy: invalid.value } : {}),
        };
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await assert.rejects(
        surface.call("codex_turn", {
          text: "must not start",
          cwd: "D:\\work",
          approval_policy: "never",
        }),
        /approvalPolicy/,
      );
      assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start"]);
    });
  }
});

test("codex_turn fails closed before turn/start for unusable returned sandbox policies", async (t) => {
  const invalidPolicies: Array<{ name: string; includeSandbox: boolean; value?: unknown }> = [
    { name: "missing", includeSandbox: false },
    { name: "non-object", includeSandbox: true, value: "workspaceWrite" },
    { name: "array", includeSandbox: true, value: [{ type: "workspaceWrite" }] },
    { name: "missing discriminator", includeSandbox: true, value: {} },
    { name: "unknown discriminator", includeSandbox: true, value: { type: "futurePolicy" } },
    { name: "mismatched discriminator", includeSandbox: true, value: { type: "readOnly" } },
  ];

  for (const invalid of invalidPolicies) {
    await t.test(invalid.name, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method !== "thread/start") {
          throw new Error(`unexpected request ${method}`);
        }
        return {
          thread: { id: "thread-invalid" },
          ...(invalid.includeSandbox ? { sandbox: invalid.value } : {}),
        };
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await assert.rejects(
        surface.call("codex_turn", {
          text: "must not start",
          cwd: "D:\\work",
          sandbox: "workspace-write",
        }),
        /sandbox/,
      );
      assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start"]);
    });
  }
});

test("codex_models maps one bounded native page and preserves sanitized future fields", async () => {
  const manager = new StubAppServerManager((method) => {
    assert.equal(method, "model/list");
    return {
      data: [{
        id: "model-id",
        model: "model-native",
        displayName: "Model Display",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        upgrade: "upgrade-id",
        upgradeInfo: { message: "Upgrade available" },
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: true,
        futureCapability: { mode: "preserved" },
      }],
      nextCursor: "next-opaque",
    };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  const result = object(await surface.call("codex_models", {
    limit: 3,
    cursor: "current-opaque",
    include_hidden: true,
  }));

  assert.deepEqual(manager.requests, [{
    method: "model/list",
    params: { limit: 3, includeHidden: true, cursor: "current-opaque" },
  }]);
  assert.equal(result.source, "codex_app_server_model_list");
  assert.equal(result.nextCursor, "next-opaque");
  const entries = result.data as Array<Record<string, unknown>>;
  assert.equal(entries[0]?.model, "model-native");
  assert.deepEqual(entries[0]?.futureCapability, { mode: "preserved" });
});

test("codex_rate_limits directly reads, normalizes, bounds, and sanitizes quota state", async () => {
  const manager = new StubAppServerManager((method, params) => {
    assert.equal(method, "account/rateLimits/read");
    assert.deepEqual(params, {});
    return {
      planType: "plus",
      spendControlReached: false,
      credits: { balance: 12, accessToken: "must-not-leak" },
      rateLimits: {
        limitId: "codex",
        limitName: null,
        planType: "plus",
        rateLimitReachedType: null,
        primary: { usedPercent: -5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 125, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: null,
        },
        future_meter: {
          limitId: "future_meter",
          limitName: "Future meter",
          rateLimitReachedType: "futureState",
          primary: { usedPercent: 40.5, windowDurationMins: 60, resetsAt: 1_800_200_000 },
          secondary: null,
        },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{
          id: "RateLimitResetCredit_internal",
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1_799_000_000,
          expiresAt: null,
          title: "Reset credit",
          description: "Bearer abcdefghijklmnop",
        }],
      },
      accountToken: "must-not-leak",
    };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  const result = object(await surface.call("codex_rate_limits", {}));

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "account/rateLimits/read",
  ]);
  assert.equal(result.source, "codex_app_server_rate_limits");
  assert.equal(result.planType, "plus");
  assert.equal(result.spendControlReached, false);
  assert.deepEqual(result.credits, { balance: 12, accessToken: "[REDACTED]" });
  const main = object(result.rateLimits);
  assert.deepEqual(main.primary, {
    usedPercent: 0,
    remainingPercent: 100,
    windowDurationMins: 300,
    resetsAt: 1_800_000_000,
  });
  assert.deepEqual(main.secondary, {
    usedPercent: 100,
    remainingPercent: 0,
    windowDurationMins: 10_080,
    resetsAt: 1_800_100_000,
  });
  const limits = object(result.rateLimitsByLimitId);
  assert.ok("future_meter" in limits);
  assert.equal(object(object(limits.future_meter).primary).remainingPercent, 59.5);
  const resetCredits = object(result.rateLimitResetCredits);
  assert.equal(resetCredits.availableCount, 1);
  const resetDetails = resetCredits.credits as Array<Record<string, unknown>>;
  assert.equal("id" in resetDetails[0]!, false);
  assert.equal(resetDetails[0]?.description, "Bearer [REDACTED]");
  assert.equal("accountToken" in result, false);
});

test("codex_rate_limits rejects malformed and upstream error responses without starting work", async (t) => {
  await t.test("malformed response", async () => {
    const manager = new StubAppServerManager(() => ({ rateLimits: { limitId: "codex", primary: "bad" } }));
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(surface.call("codex_rate_limits", {}), /primary must be an object/);
    assert.deepEqual(manager.requests.map((request) => request.method), ["account/rateLimits/read"]);
  });

  await t.test("JSON-RPC error", async () => {
    const manager = new StubAppServerManager(() => {
      throw new Error("Codex app-server account/rateLimits/read failed: unsupported");
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(surface.call("codex_rate_limits", {}), /unsupported/);
    assert.deepEqual(manager.requests.map((request) => request.method), ["account/rateLimits/read"]);
  });
});

test("ordinary codex_turn continuation omits model and effort without listing models", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/resume") {
      return { thread: { id: "thread-existing" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-existing", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", { text: "continue", thread_id: "thread-existing" });

  assert.deepEqual(manager.requests.map((request) => request.method), ["thread/resume", "turn/start"]);
  for (const request of manager.requests) {
    const params = object(request.params);
    assert.equal("model" in params, false);
    assert.equal("effort" in params, false);
  }
});

test("explicit hidden model is found through cycle-safe pagination and passed through unchanged", async () => {
  const manager = new StubAppServerManager((method, params) => {
    if (method === "model/list") {
      return object(params).cursor === undefined
        ? { data: [{ id: "visible", model: "visible-native", hidden: false }], nextCursor: "page-2" }
        : { data: [{ id: "hidden-id", model: "hidden-native", hidden: true }], nextCursor: null };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-hidden" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-hidden", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "hidden model",
    thread_id: "thread-hidden",
    model: "hidden-id",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "model/list",
    "model/list",
    "thread/resume",
    "turn/start",
  ]);
  assert.deepEqual(object(manager.requests[0]?.params), { limit: 100, includeHidden: true });
  assert.deepEqual(object(manager.requests[1]?.params), {
    limit: 100,
    includeHidden: true,
    cursor: "page-2",
  });
  assert.equal(object(manager.requests[2]?.params).model, "hidden-id");
  assert.equal(object(manager.requests[3]?.params).model, "hidden-id");
});

test("explicit model overrides reject unknown models before thread mutation", async () => {
  const manager = new StubAppServerManager((method) => {
    assert.equal(method, "model/list");
    return { data: [{ id: "known", model: "known-native" }], nextCursor: null };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await assert.rejects(
    surface.call("codex_turn", {
      text: "unknown model",
      thread_id: "thread-known",
      model: "missing",
    }),
    /Unknown model override "missing"/,
  );
  assert.deepEqual(manager.requests.map((request) => request.method), ["model/list"]);
});

test("model plus effort validates advertised support and passes exact tokens", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "model/list") {
      return {
        data: [{
          id: "reasoning-model",
          model: "reasoning-native",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Deep" },
          ],
        }],
        nextCursor: null,
      };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-reasoning" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-reasoning", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "supported effort",
    thread_id: "thread-reasoning",
    model: "reasoning-native",
    effort: "high",
  });

  assert.equal(object(manager.requests[1]?.params).model, "reasoning-native");
  assert.equal(object(manager.requests[2]?.params).model, "reasoning-native");
  assert.equal(object(manager.requests[2]?.params).effort, "high");
});

test("model plus effort rejects unsupported advertised effort but tolerates absent support data", async (t) => {
  await t.test("advertised unsupported", async () => {
    const manager = new StubAppServerManager((method) => {
      assert.equal(method, "model/list");
      return {
        data: [{
          id: "bounded-model",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        }],
        nextCursor: null,
      };
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(
      surface.call("codex_turn", {
        text: "unsupported effort",
        thread_id: "thread-bounded",
        model: "bounded-model",
        effort: "high",
      }),
      /Unsupported effort "high" for model "bounded-model".*medium/,
    );
    assert.deepEqual(manager.requests.map((request) => request.method), ["model/list"]);
  });

  await t.test("support field absent", async () => {
    const manager = new StubAppServerManager((method) => {
      if (method === "model/list") {
        return { data: [{ id: "native-authoritative" }], nextCursor: null };
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-native" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-native", status: "inProgress" } };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await surface.call("codex_turn", {
      text: "native decides",
      thread_id: "thread-native",
      model: "native-authoritative",
      effort: "future-effort",
    });
    assert.equal(object(manager.requests[2]?.params).effort, "future-effort");
  });
});

test("effort-only validation uses the catalog-wide advertised union without inferring a model", async (t) => {
  await t.test("advertised somewhere passes through", async () => {
    const manager = new StubAppServerManager((method) => {
      if (method === "model/list") {
        return {
          data: [
            { id: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
            { id: "model-b", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-effort" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-effort", status: "inProgress" } };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await surface.call("codex_turn", {
      text: "effort only",
      thread_id: "thread-effort",
      effort: "xhigh",
    });
    assert.equal("model" in object(manager.requests[1]?.params), false);
    assert.equal("model" in object(manager.requests[2]?.params), false);
    assert.equal(object(manager.requests[2]?.params).effort, "xhigh");
  });

  await t.test("absent everywhere rejects before mutation", async () => {
    const manager = new StubAppServerManager((method) => {
      assert.equal(method, "model/list");
      return {
        data: [{ id: "model-only", supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
        ] }],
        nextCursor: null,
      };
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(
      surface.call("codex_turn", {
        text: "unknown effort",
        thread_id: "thread-effort",
        effort: "impossible",
      }),
      /absent from all advertised supportedReasoningEfforts.*does not infer the current thread model.*low, medium/,
    );
    assert.deepEqual(manager.requests.map((request) => request.method), ["model/list"]);
  });
});

test("model catalog pagination cycles fail locally before thread mutation", async () => {
  let page = 0;
  const manager = new StubAppServerManager((method) => {
    assert.equal(method, "model/list");
    page += 1;
    return {
      data: [{ id: `other-${page}` }],
      nextCursor: "repeat-cursor",
    };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await assert.rejects(
    surface.call("codex_turn", {
      text: "cycle",
      thread_id: "thread-cycle",
      model: "missing",
    }),
    /pagination cursor cycle detected/,
  );
  assert.deepEqual(manager.requests.map((request) => request.method), ["model/list", "model/list"]);
});

test("public tool schemas expose the same string bounds already enforced at runtime", () => {
  const expected: Array<[string, string, number]> = [
    ["codex_threads", "thread_id", 200],
    ["codex_threads", "cwd", 1_000],
    ["codex_threads", "cursor", 10_000],
    ["codex_turn", "thread_id", 200],
    ["codex_turn", "cwd", 1_000],
    ["codex_observe", "thread_id", 200],
    ["codex_steer", "thread_id", 200],
    ["codex_steer", "expected_turn_id", 200],
    ["codex_respond", "thread_id", 200],
    ["codex_respond", "turn_id", 200],
    ["codex_respond", "method", 300],
    ["codex_interrupt", "thread_id", 200],
    ["codex_interrupt", "turn_id", 200],
  ];

  for (const [tool, property, maxLength] of expected) {
    assert.equal(
      propertySchema(tool, property).maxLength,
      maxLength,
      `${tool}.${property}`,
    );
  }
});

test("ControlSurface delegates native cwd normalization to the selected policy", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-darwin" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-darwin", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "native path",
    cwd: "/Users/example/../bridge",
  });

  assert.equal(object(manager.requests[0]?.params).cwd, "/Users/bridge");
  assert.equal(object(manager.requests[1]?.params).cwd, "/Users/bridge");
  await assert.rejects(
    surface.call("codex_turn", { text: "relative", cwd: "Users/example" }),
    /absolute POSIX path on macOS/,
  );
});

test("codex_turn auto recall is disabled by default and preserves exact original text", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: undefined });
  let memoryCalls = 0;
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { memoryCalls += 1; return { items: [] }; },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const original = "  exact original task\nwith spacing  ";
  const result = object(await surface.call("codex_turn", { text: original, cwd: "/tmp/project" }));
  assert.equal(forwardedTurnText(manager), original);
  assert.deepEqual(result.memory_recall, { status: "disabled" });
  assert.equal(memoryCalls, 0);
});

test("completed fresh turn queues exactly one bounded project-scoped automatic writeback", async (t) => {
  setAutoRecallEnv(t, {
    TDAI_MEMORY_AUTO_RECALL: "1",
    TDAI_MEMORY_AUTO_WRITEBACK: "1",
    TDAI_MEMORY_AUTO_WRITEBACK_MAX_CHARS: "500",
    TDAI_MEMORY_AUTO_RECALL_AGENT_ID: undefined,
    TDAI_MEMORY_AUTO_RECALL_USER_ID: undefined,
    TDAI_MEMORY_AUTO_RECALL_SESSION_ID: undefined,
  });
  const manager = turnManager();
  const root = await mkdtemp(join(tmpdir(), "lcb-writeback-"));
  const repo = join(root, "ProjectAlpha");
  await mkdir(join(repo, ".git"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const writes: unknown[] = [];
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { return { items: [{ content: "RECALLED_SENTINEL_DO_NOT_WRITE_BACK" }] }; },
    async conversationAdd(input: unknown) { writes.push(input); return { acceptedIds: ["accepted"] }; },
  });
  const accepted = object(await surface.call("codex_turn", {
    text: `Record durable decision: use SQLite.${"x".repeat(800)}`,
    cwd: repo,
  }));
  manager.runtime.recordNotification("turn/completed", {
    threadId: accepted.thread_id,
    turn: { id: accepted.turn_id, status: "completed", items: [{ type: "agentMessage", text: `Verified SQLite decision.${"y".repeat(800)}` }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  const write = object(writes[0]);
  assert.equal(write.teamId, "projectalpha");
  assert.equal(write.agentId, "shared-project-memory");
  assert.equal(write.userId, "owner");
  assert.equal(write.sessionId, "lcb-auto-recall");
  const messages = write.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 2);
  const taskMessage = object(messages[0]);
  const resultMessage = object(messages[1]);
  assert.match(String(taskMessage.content), /Extract only durable, project-scoped facts or decisions/);
  assert.match(String(taskMessage.content), /Record durable decision: use SQLite/);
  assert.doesNotMatch(String(taskMessage.content), /RECALLED_SENTINEL_DO_NOT_WRITE_BACK|ADVISORY MEMORY RECALL/);
  assert.ok(String(taskMessage.content).length < 1_200);
  assert.ok(String(resultMessage.content).length < 700);
  assert.equal(object(manager.runtime.observe(String(accepted.thread_id), 0, 20)?.terminal).memory_writeback, "written");
});

test("failed and interrupted turns never write back", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1", TDAI_MEMORY_AUTO_WRITEBACK: "1" });
  let writes = 0;
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { return { items: [] }; },
    async conversationAdd() { writes += 1; return { acceptedIds: [] }; },
  });
  for (const status of ["failed", "interrupted"]) {
    const accepted = object(await surface.call("codex_turn", { text: "task", cwd: `/tmp/${status}` }));
    manager.runtime.recordNotification("turn/completed", {
      threadId: accepted.thread_id,
      turn: { id: accepted.turn_id, status, items: [] },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("automatic writeback failure is asynchronous and leaves terminal completion successful", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1", TDAI_MEMORY_AUTO_WRITEBACK: "1" });
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { return { items: [] }; },
    async conversationAdd() { throw new Error("unavailable"); },
  });
  const accepted = object(await surface.call("codex_turn", { text: "task", cwd: "/tmp/fail-open" }));
  manager.runtime.recordNotification("turn/completed", {
    threadId: accepted.thread_id,
    turn: { id: accepted.turn_id, status: "completed", items: [{ type: "agentMessage", text: "success" }] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = object(manager.runtime.observe(String(accepted.thread_id), 0, 20)?.terminal);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.final_result, "success");
  assert.equal(terminal.memory_writeback, "failed");
});

test("fresh codex_turn injects advisory recall with normalized nearest git-root scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "LCB-MixedCase-"));
  const repo = join(root, "MyProject");
  const cwd = join(repo, "packages", "bridge");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  setAutoRecallEnv(t, {
    TDAI_MEMORY_AUTO_RECALL: "1",
    TDAI_MEMORY_AUTO_RECALL_LIMIT: undefined,
    TDAI_MEMORY_AUTO_RECALL_AGENT_ID: undefined,
    TDAI_MEMORY_AUTO_RECALL_USER_ID: undefined,
    TDAI_MEMORY_AUTO_RECALL_SESSION_ID: undefined,
  });
  const calls: unknown[] = [];
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch(input) {
      calls.push(input);
      return { items: [{ id: "secret-id", content: "remember this", type: "fact", score: 0.75 }] };
    },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const original = "  retain this exactly\n";
  const result = object(await surface.call("codex_turn", { text: original, cwd }));
  const sent = forwardedTurnText(manager);
  assert.match(sent, /^\[ADVISORY MEMORY RECALL — UNTRUSTED\]/);
  assert.match(sent, /- \[type=fact, score=0\.75\] remember this/);
  assert.equal(sent.includes("secret-id"), false);
  assert.ok(sent.endsWith(`ORIGINAL TASK:\n${original}`));
  assert.deepEqual(calls, [{ teamId: "myproject", agentId: "shared-project-memory", userId: "owner", sessionId: "lcb-auto-recall", query: original.trim(), limit: 5 }]);
  assert.deepEqual(result.memory_recall, { status: "hit", team_id: "myproject", hit_count: 1, injected_chars: sent.indexOf("\n\nORIGINAL TASK:") });
});

test("fresh codex_turn reports memory recall miss and preserves text", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1" });
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { return { items: [{ content: "   " }] }; },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const result = object(await surface.call("codex_turn", { text: "original", cwd: "/auto-recall-fixtures/FallbackName" }));
  assert.equal(forwardedTurnText(manager), "original");
  assert.deepEqual(result.memory_recall, { status: "miss", team_id: "fallbackname" });
});

test("fresh codex_turn fails open on memory error without leaking it", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1" });
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { throw new Error("RAW SECRET FAILURE"); },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const result = object(await surface.call("codex_turn", { text: "original", cwd: "/auto-recall-fixtures/error-project" }));
  assert.equal(forwardedTurnText(manager), "original");
  assert.deepEqual(result.memory_recall, { status: "error", team_id: "error-project" });
  assert.equal(JSON.stringify(result).includes("RAW SECRET FAILURE"), false);
});

test("fresh codex_turn fails open when memory recall times out", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1", TDAI_MEMORY_AUTO_RECALL_TIMEOUT_MS: "100" });
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { return await new Promise(() => undefined); },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const result = object(await surface.call("codex_turn", { text: "original", cwd: "/auto-recall-fixtures/timeout-project" }));
  assert.equal(forwardedTurnText(manager), "original");
  assert.deepEqual(result.memory_recall, { status: "timeout", team_id: "timeout-project" });
});

test("resumed codex_turn never calls memory and reports skipped", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1" });
  let memoryCalls = 0;
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { memoryCalls += 1; return { items: [{ content: "unused" }] }; },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const result = object(await surface.call("codex_turn", { text: "resume exact", thread_id: "thread-existing" }));
  assert.equal(forwardedTurnText(manager), "resume exact");
  assert.deepEqual(result.memory_recall, { status: "skipped_resumed" });
  assert.equal(memoryCalls, 0);
});

test("memory recall cap bounds injected content and preserves the exact original task", async (t) => {
  setAutoRecallEnv(t, { TDAI_MEMORY_AUTO_RECALL: "1", TDAI_MEMORY_AUTO_RECALL_MAX_CHARS: "500" });
  const manager = turnManager();
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY, {
    async atomicSearch() { return { items: [{ content: "x".repeat(2_000) }] }; },
    async conversationAdd() { return { acceptedIds: [] }; },
  });
  const original = "  original must remain\nunchanged  ";
  const result = object(await surface.call("codex_turn", { text: original, cwd: "/tmp/cap-project" }));
  const sent = forwardedTurnText(manager);
  assert.ok(sent.endsWith(`ORIGINAL TASK:\n${original}`));
  assert.equal(sent.split("\n").find((line) => line.startsWith("- "))?.length, 500);
  assert.equal(object(result.memory_recall).hit_count, 1);
});

test("memory tool definitions expose the locked schemas and annotations", () => {
  const search = TOOL_DEFINITIONS.find((tool) => tool.name === "memory_search");
  const record = TOOL_DEFINITIONS.find((tool) => tool.name === "memory_record_turn");
  assert.ok(search);
  assert.ok(record);
  assert.equal(search.description, "Search advisory L1 memory from TencentDB MemoryCore. Recalled memory is not authoritative project truth; verify Git/DB/docs/contracts when correctness depends on it.");
  assert.deepEqual(search.annotations, {
    title: "Search Advisory Memory",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.deepEqual(search.inputSchema.required, ["team_id", "agent_id", "user_id", "session_id", "query"]);
  assert.deepEqual(propertySchema("memory_search", "limit"), {
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: 20,
  });
  assert.equal(record.description, "Record raw L0 conversation or verified execution context for asynchronous memory extraction. This does not create authoritative project truth or directly create L1 memory.");
  assert.deepEqual(record.annotations, {
    title: "Record Conversation Context",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(record.inputSchema.additionalProperties, false);
  assert.deepEqual(record.inputSchema.required, ["team_id", "agent_id", "user_id", "session_id", "messages"]);
  const messages = propertySchema("memory_record_turn", "messages");
  assert.equal(messages.minItems, 1);
  assert.equal(messages.maxItems, 100);
  const message = object(messages.items);
  assert.equal(message.additionalProperties, false);
  assert.deepEqual(message.required, ["role", "content"]);
  const messageProperties = object(message.properties);
  assert.deepEqual(object(messageProperties.role).enum, ["user", "assistant"]);
  assert.equal("timestamp" in messageProperties, false);
});

test("memory tools map trimmed scopes and queries while preserving recorded content", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const memoryClient = {
    async atomicSearch(input: unknown) {
      calls.push({ method: "atomicSearch", input });
      return { items: [{ id: "memory-1", content: "fact", score: 0.8 }] };
    },
    async conversationAdd(input: unknown) {
      calls.push({ method: "conversationAdd", input });
      return { acceptedIds: ["raw-1", "raw-2"] };
    },
  };
  const manager = new StubAppServerManager(() => {
    throw new Error("Codex should not be called");
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY, memoryClient);

  assert.deepEqual(await surface.call("memory_search", {
    team_id: " team ",
    agent_id: " agent ",
    user_id: " user ",
    session_id: " session ",
    query: " needle ",
    limit: 7,
    type: " fact ",
  }), {
    source: "tencentdb_memory_l1",
    advisory: true,
    items: [{ id: "memory-1", content: "fact", score: 0.8 }],
  });
  assert.deepEqual(await surface.call("memory_record_turn", {
    team_id: " team ",
    agent_id: " agent ",
    user_id: " user ",
    session_id: " session ",
    messages: [
      { role: "user", content: "  preserve me  " },
      { role: "assistant", content: "answer" },
    ],
  }), {
    source: "tencentdb_memory_l0",
    accepted_count: 2,
    pipeline_async: true,
  });
  assert.deepEqual(calls, [
    {
      method: "atomicSearch",
      input: {
        teamId: "team",
        agentId: "agent",
        userId: "user",
        sessionId: "session",
        query: "needle",
        limit: 7,
        type: "fact",
      },
    },
    {
      method: "conversationAdd",
      input: {
        teamId: "team",
        agentId: "agent",
        userId: "user",
        sessionId: "session",
        messages: [
          { role: "user", content: "  preserve me  " },
          { role: "assistant", content: "answer" },
        ],
      },
    },
  ]);
  assert.deepEqual(manager.requests, []);
});

test("memory tools reject invalid arguments before calling the injected client", async () => {
  let calls = 0;
  const memoryClient = {
    async atomicSearch() {
      calls += 1;
      return { items: [] };
    },
    async conversationAdd() {
      calls += 1;
      return { acceptedIds: [] };
    },
  };
  const manager = new StubAppServerManager(() => undefined);
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY, memoryClient);
  const scope = { team_id: "team", agent_id: "agent", user_id: "user", session_id: "session" };
  const invalidSearch = [
    { ...scope, query: "q", extra: true },
    { ...scope, query: " " },
    { ...scope, query: "q", team_id: " " },
    { ...scope, query: "q", limit: 0 },
    { ...scope, query: "q", limit: 1.5 },
    { ...scope, query: "q", type: " " },
  ];
  for (const input of invalidSearch) {
    await assert.rejects(surface.call("memory_search", input));
  }
  const invalidRecord = [
    { ...scope, messages: [], extra: true },
    { ...scope, messages: [] },
    { ...scope, messages: [{}] },
    { ...scope, messages: [{ role: "tool", content: "x" }] },
    { ...scope, messages: [{ role: "user", content: " " }] },
    { ...scope, messages: [{ role: "user", content: "x", timestamp: "now" }] },
    { ...scope, messages: "not-an-array" },
  ];
  for (const input of invalidRecord) {
    await assert.rejects(surface.call("memory_record_turn", input));
  }
  assert.equal(calls, 0);
});

test("memory tools require configuration lazily and propagate sanitized upstream failures", async () => {
  const originalKey = process.env.TDAI_GATEWAY_API_KEY;
  delete process.env.TDAI_GATEWAY_API_KEY;
  try {
    const manager = new StubAppServerManager(() => undefined);
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(
      surface.call("memory_search", {
        team_id: "team",
        agent_id: "agent",
        user_id: "user",
        session_id: "session",
        query: "q",
      }),
      /^Error: TencentDB memory is not configured: TDAI_GATEWAY_API_KEY is missing$/,
    );
  } finally {
    if (originalKey === undefined) delete process.env.TDAI_GATEWAY_API_KEY;
    else process.env.TDAI_GATEWAY_API_KEY = originalKey;
  }

  const fakeSecret = "FAKE-MEMORY-SECRET";
  const memoryClient = {
    async atomicSearch() {
      throw new Error("MemoryCore atomicSearch HTTP 503");
    },
    async conversationAdd() {
      return { acceptedIds: [] };
    },
  };
  const surface = new ControlSurface(
    new StubAppServerManager(() => undefined),
    undefined,
    WINDOWS_PLATFORM_POLICY,
    memoryClient,
  );
  const error = await surface.call("memory_search", {
    team_id: "team",
    agent_id: "agent",
    user_id: "user",
    session_id: "session",
    query: "q",
  }).then(() => new Error("expected rejection"), (reason: unknown) => reason);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "MemoryCore atomicSearch HTTP 503");
  assert.equal(error.message.includes(fakeSecret), false);
});
