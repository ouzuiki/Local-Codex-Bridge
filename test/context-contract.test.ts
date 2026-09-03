import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentsUrl = new URL("./fixtures/tri-worker-context/AGENTS.md", import.meta.url);
const claudeUrl = new URL("./fixtures/tri-worker-context/CLAUDE.md", import.meta.url);

const TOKEN = "TRI_BRIDGE_CONTEXT_OK_7F29";
const TASK = "What is TRI_BRIDGE_CONTEXT_TOKEN? Return only the token.";

test("tri-worker context fixture has one authoritative token source and a thin Claude shim", async () => {
  const [agents, claude] = await Promise.all([
    readFile(agentsUrl, "utf8"),
    readFile(claudeUrl, "utf8"),
  ]);

  assert.match(agents, new RegExp(TOKEN));
  assert.equal(claude.trim(), "@AGENTS.md");
  assert.equal(claude.includes(TOKEN), false);
  assert.equal(TASK.includes(TOKEN), false);
});
