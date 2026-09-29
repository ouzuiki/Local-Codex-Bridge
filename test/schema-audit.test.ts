import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NATIVE_GROUPS } from "../src/native.js";

type Entry = { classification: string; fields: string[]; required: string[] };
type Manifest = { version: string; stable: Record<string, Entry>; experimentalOnly: Record<string, Entry>; experimentalOverrides: Record<string, Pick<Entry, "fields" | "required">>; stableServerRequests: string[] };
const manifest = JSON.parse(readFileSync(join(process.cwd(), "audit/methods-0.156.json"), "utf8")) as Manifest;

function generated(experimental: boolean): { clients: Record<string, Pick<Entry, "fields" | "required">>; servers: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "lcb-schema-audit-"));
  try {
    const result = spawnSync(process.env.CODEX_EXE || "codex", ["app-server", "generate-json-schema", ...(experimental ? ["--experimental"] : []), "--out", directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const schema = JSON.parse(readFileSync(join(directory, "ClientRequest.json"), "utf8")) as Record<string, any>;
    const serverSchema = JSON.parse(readFileSync(join(directory, "ServerRequest.json"), "utf8")) as Record<string, any>;
    const clients = Object.fromEntries(schema.oneOf.map((request: any) => {
      const name = request.properties.method.enum[0] as string;
      const reference = request.properties.params;
      const params = reference?.$ref ? schema.definitions[reference.$ref.split("/").at(-1)] : reference;
      return [name, { fields: Object.keys(params?.properties ?? {}).sort(), required: [...(params?.required ?? [])].sort() }];
    }));
    return { clients, servers: serverSchema.oneOf.map((request: any) => request.properties.method.enum[0]).sort() };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("installed 0.156 schema methods and parameter fields match the audited classification", () => {
  const version = spawnSync(process.env.CODEX_EXE || "codex", ["--version"], { encoding: "utf8" });
  assert.match(version.stdout, /0\.156\.0/);
  const stableGenerated = generated(false);
  const experimentalGenerated = generated(true);
  const stable = stableGenerated.clients;
  const experimental = experimentalGenerated.clients;
  assert.deepEqual(stableGenerated.servers, manifest.stableServerRequests);
  assert.deepEqual(Object.keys(stable).sort(), Object.keys(manifest.stable).sort());
  assert.deepEqual(Object.keys(experimental).sort(), [...Object.keys(manifest.stable), ...Object.keys(manifest.experimentalOnly)].sort());
  for (const [name, entry] of Object.entries(manifest.stable)) {
    assert.deepEqual(stable[name], { fields: entry.fields, required: entry.required }, name);
  }
  for (const [name, entry] of Object.entries(manifest.experimentalOnly)) {
    assert.deepEqual(experimental[name], { fields: entry.fields, required: entry.required }, name);
  }
  for (const [name, entry] of Object.entries(manifest.experimentalOverrides)) assert.deepEqual(experimental[name], entry, name);
  for (const [name, entry] of Object.entries(manifest.stable)) {
    if (!manifest.experimentalOverrides[name]) assert.deepEqual(experimental[name], { fields: entry.fields, required: entry.required }, name);
  }
  const categories = new Set(["ergonomic", "public-read", "public-action", "redesign", "internal"]);
  for (const entry of [...Object.values(manifest.stable), ...Object.values(manifest.experimentalOnly)]) assert.ok(categories.has(entry.classification));
  for (const [group, methods] of Object.entries(NATIVE_GROUPS)) {
    const category = group.endsWith("read") ? "public-read" : "public-action";
    for (const [method, spec] of Object.entries(methods)) {
      const entry = manifest.stable[method] ?? manifest.experimentalOnly[method];
      assert.equal(entry?.classification, category, `${group}: ${method}`);
      const current = group.includes("experimental") ? experimental[method] : stable[method];
      assert.ok(current, `${group}: ${method} missing from native schema`);
      for (const field of Object.keys(spec.fields)) assert.ok(current.fields.includes(field), `${group}: ${method}.${field} is not in native schema`);
    }
  }
});
