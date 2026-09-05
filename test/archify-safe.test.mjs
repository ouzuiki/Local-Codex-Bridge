import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER_PATH = fileURLToPath(new URL('../scripts/archify-safe.mjs', import.meta.url));

const FAKE_RUNTIME_SOURCE = `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , , , specPath, candidatePath] = process.argv;
let control = { mode: 'success' };
const controlPath = specPath + '.control.json';
if (existsSync(controlPath)) {
  control = JSON.parse(readFileSync(controlPath, 'utf8'));
}

if (control.envMarkerPath) {
  writeFileSync(control.envMarkerPath, JSON.stringify({
    ARCHIFY_UPDATE_CHECK_DISABLED: process.env.ARCHIFY_UPDATE_CHECK_DISABLED ?? null,
  }));
}

if (control.mode === 'fail') {
  process.stderr.write('simulated failure\\n');
  process.exit(1);
}

if (control.mode === 'invalid-html') {
  writeFileSync(candidatePath, 'plain text, not html');
  process.exit(0);
}

writeFileSync(candidatePath, '<!doctype html>\\n<html><body>fake archify output</body></html>\\n');
process.exit(0);
`;

function mkTmp(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeRuntime(version = '2.16.0') {
  const pkgDir = mkTmp('archify-safe-runtime-');
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'archify', version }),
  );
  const binPath = path.join(pkgDir, 'bin.mjs');
  writeFileSync(binPath, FAKE_RUNTIME_SOURCE);
  chmodSync(binPath, 0o755);
  return binPath;
}

function writeSpec(dir, contents = '{"nodes":[]}') {
  const specPath = path.join(dir, 'spec.json');
  writeFileSync(specPath, contents);
  return specPath;
}

function writeControl(specPath, control) {
  writeFileSync(`${specPath}.control.json`, JSON.stringify(control));
}

function runWrapper(args, envOverrides = {}) {
  const result = spawnSync(process.execPath, [WRAPPER_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
  return result;
}

function parseStdoutJson(result) {
  return JSON.parse(result.stdout.trim());
}

function parseStderrJson(result) {
  return JSON.parse(result.stderr.trim());
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function cleanupDirs(...dirs) {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('1: successful deliver returns a receipt with correct hash/bytes fields', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    const result = runWrapper([
      'deliver',
      '--cwd', cwd,
      '--runtime', runtime,
      '--type', 'architecture',
      '--spec', specPath,
      '--name', 'out.html',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const receipt = parseStdoutJson(result);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.receiptVersion, '1.0.0');
    assert.equal(receipt.profileVersion, '1.0.0');
    assert.equal(receipt.archify.pin, 'v2.16.0');
    assert.equal(receipt.archify.identityStatus, 'verified');
    assert.equal(receipt.archify.detectedVersion, '2.16.0');
    assert.equal(receipt.child.exitCode, 0);
    assert.equal(receipt.child.updateCheckDisabled, true);
    assert.equal(receipt.finalRelativePath, path.join('.artifacts', 'archify', 'out.html'));
    assert.equal(receipt.claims.deterministicSchema, 'not_separately_verified');
    assert.equal(receipt.claims.runtimeBrowser, 'not_performed');
    assert.equal(receipt.claims.perceptual, 'not_performed');
    assert.equal(receipt.claims.human, 'not_performed');
    assert.equal(typeof receipt.child.stdout, 'undefined');
    assert.equal(typeof receipt.child.stderr, 'undefined');

    const finalPath = path.join(cwd, '.artifacts', 'archify', 'out.html');
    assert.ok(existsSync(finalPath));
    const finalBuf = readFileSync(finalPath);
    assert.equal(receipt.artifact.sha256, sha256Of(finalBuf));
    assert.equal(receipt.artifact.bytes, finalBuf.length);

    const specBuf = readFileSync(specPath);
    assert.equal(receipt.spec.sha256, sha256Of(specBuf));
    assert.equal(receipt.spec.bytes, specBuf.length);
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('2: absolute output names are rejected (POSIX and Windows-style)', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    for (const badName of ['/etc/evil.html', 'C:\\Users\\evil.html', '\\\\server\\share\\evil.html']) {
      const result = runWrapper([
        'deliver', '--cwd', cwd, '--runtime', runtime,
        '--type', 'architecture', '--spec', specPath, '--name', badName,
      ]);
      assert.notEqual(result.status, 0, `expected rejection for ${badName}`);
      const err = parseStderrJson(result);
      assert.equal(err.ok, false);
      assert.equal(err.error.code, 'output_name_invalid');
    }
    assert.deepEqual(readdirSync(cwd).filter((n) => n !== 'spec.json' && n !== 'spec.json.control.json'), []);
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('3: ".." traversal in --name is rejected', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    const result = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', '../evil.html',
    ]);
    assert.notEqual(result.status, 0);
    const err = parseStderrJson(result);
    assert.equal(err.error.code, 'output_name_invalid');
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('4: absolute or escaping --artifact-root override is rejected', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    for (const badRoot of ['/tmp/evil-root', '../evil-root']) {
      const result = runWrapper([
        'deliver', '--cwd', cwd, '--runtime', runtime,
        '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
        '--artifact-root', badRoot,
      ]);
      assert.notEqual(result.status, 0, `expected rejection for ${badRoot}`);
      const err = parseStderrJson(result);
      assert.equal(err.error.code, 'artifact_root_invalid');
    }
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('5: pre-existing artifact-root symlink to outside cwd is rejected before any outside write', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  const outside = mkTmp('archify-safe-outside-');
  try {
    symlinkSync(outside, path.join(cwd, '.artifacts'));
    const specPath = writeSpec(cwd);
    const result = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
    ]);
    assert.notEqual(result.status, 0);
    const err = parseStderrJson(result);
    assert.equal(err.error.code, 'artifact_root_invalid');
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanupDirs(cwd, outside, path.dirname(runtime));
  }
});

test('6: nested output parent symlink escape is rejected before any outside write', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  const outside = mkTmp('archify-safe-outside-');
  try {
    const artifactRoot = path.join(cwd, '.artifacts', 'archify');
    mkdirSync(artifactRoot, { recursive: true });
    symlinkSync(outside, path.join(artifactRoot, 'subdir'));
    const specPath = writeSpec(cwd);
    const result = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'subdir/out.html',
    ]);
    assert.notEqual(result.status, 0);
    const err = parseStderrJson(result);
    assert.equal(err.error.code, 'output_name_invalid');
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    cleanupDirs(cwd, outside, path.dirname(runtime));
  }
});

test('7: non-html --name is rejected', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    const result = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.txt',
    ]);
    assert.notEqual(result.status, 0);
    const err = parseStderrJson(result);
    assert.equal(err.error.code, 'output_name_invalid');
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('8: ARCHIFY_UPDATE_CHECK_DISABLED=1 is forced for the child regardless of ambient env', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    const markerPath = path.join(cwd, 'env-marker.json');
    writeControl(specPath, { mode: 'success', envMarkerPath: markerPath });
    const result = runWrapper(
      ['deliver', '--cwd', cwd, '--runtime', runtime, '--type', 'architecture', '--spec', specPath, '--name', 'out.html'],
      { ARCHIFY_UPDATE_CHECK_DISABLED: '0' },
    );
    assert.equal(result.status, 0, result.stderr);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.ARCHIFY_UPDATE_CHECK_DISABLED, '1');
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('9: existing last-good final is preserved byte-for-byte when child exits nonzero', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    const first = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const finalPath = path.join(cwd, '.artifacts', 'archify', 'out.html');
    const before = readFileSync(finalPath);

    writeControl(specPath, { mode: 'fail' });
    const second = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
    ]);
    assert.notEqual(second.status, 0);
    const err = parseStderrJson(second);
    assert.equal(err.error.code, 'child_failed');

    const after = readFileSync(finalPath);
    assert.deepEqual(before, after);

    const artifactDir = path.join(cwd, '.artifacts', 'archify');
    const strays = readdirSync(artifactDir).filter((n) => n !== 'out.html');
    assert.deepEqual(strays, []);
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('10: existing last-good final is preserved when candidate fails basic HTML validation despite exit 0', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd);
    const first = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
    ]);
    assert.equal(first.status, 0, first.stderr);
    const finalPath = path.join(cwd, '.artifacts', 'archify', 'out.html');
    const before = readFileSync(finalPath);

    writeControl(specPath, { mode: 'invalid-html' });
    const second = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
    ]);
    assert.notEqual(second.status, 0);
    const err = parseStderrJson(second);
    assert.equal(err.error.code, 'candidate_not_html');

    const after = readFileSync(finalPath);
    assert.deepEqual(before, after);

    const artifactDir = path.join(cwd, '.artifacts', 'archify');
    const strays = readdirSync(artifactDir).filter((n) => n !== 'out.html');
    assert.deepEqual(strays, []);
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('11: runtime version mismatch rejects deliver without invoking the child', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime('9.9.9');
  try {
    const specPath = writeSpec(cwd);
    const result = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'architecture', '--spec', specPath, '--name', 'out.html',
    ]);
    assert.notEqual(result.status, 0);
    const err = parseStderrJson(result);
    assert.equal(err.error.code, 'runtime_version_mismatch');
    assert.equal(existsSync(path.join(cwd, '.artifacts')), false);
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});

test('12: doctor reports unavailable/nonzero for a nonexistent runtime without fetching', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  try {
    const result = runWrapper([
      'doctor', '--cwd', cwd, '--runtime', '/definitely/not/installed/archify',
    ]);
    assert.notEqual(result.status, 0);
    const report = parseStdoutJson(result);
    assert.equal(report.ok, false);
    assert.equal(report.archify.available, false);
    assert.equal(report.archify.identityStatus, 'unverified');
    assert.equal(report.archify.detectedVersion, null);
  } finally {
    cleanupDirs(cwd);
  }
});

test('13: sha256/byte counts are stable and correct across repeated deliveries', () => {
  const cwd = mkTmp('archify-safe-cwd-');
  const runtime = makeFakeRuntime();
  try {
    const specPath = writeSpec(cwd, '{"nodes":["a","b","c"]}');
    const specBuf = readFileSync(specPath);
    const expectedSpecSha = sha256Of(specBuf);

    const result1 = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'workflow', '--spec', specPath, '--name', 'a.html',
    ]);
    assert.equal(result1.status, 0, result1.stderr);
    const receipt1 = parseStdoutJson(result1);

    const result2 = runWrapper([
      'deliver', '--cwd', cwd, '--runtime', runtime,
      '--type', 'workflow', '--spec', specPath, '--name', 'b.html',
    ]);
    assert.equal(result2.status, 0, result2.stderr);
    const receipt2 = parseStdoutJson(result2);

    assert.equal(receipt1.spec.sha256, expectedSpecSha);
    assert.equal(receipt2.spec.sha256, expectedSpecSha);
    assert.equal(receipt1.spec.bytes, specBuf.length);
    assert.equal(receipt2.spec.bytes, specBuf.length);
    assert.equal(receipt1.artifact.sha256, receipt2.artifact.sha256);
    assert.equal(receipt1.artifact.bytes, receipt2.artifact.bytes);

    const artifactBuf = readFileSync(path.join(cwd, '.artifacts', 'archify', 'a.html'));
    assert.equal(receipt1.artifact.sha256, sha256Of(artifactBuf));
    assert.equal(receipt1.artifact.bytes, artifactBuf.length);
  } finally {
    cleanupDirs(cwd, path.dirname(runtime));
  }
});
