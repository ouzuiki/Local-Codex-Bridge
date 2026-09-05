#!/usr/bin/env node
// Worker-neutral safety wrapper around the upstream `archify` CLI
// (tt-a1i/archify, pinned exactly to v2.16.0). See
// worker-neutral/archify/admission-profile.v1.json and README.md for the
// policy contract this file implements.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants as fsConstants,
  existsSync,
} from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

export const WRAPPER_VERSION = '1.0.0';
export const PROFILE_VERSION = '1.0.0';
export const ARCHIFY_PIN = 'v2.16.0';
export const ARCHIFY_EXPECTED_VERSION = '2.16.0';
export const DEFAULT_ARTIFACT_ROOT = '.artifacts/archify';
const VALID_TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);
const MAX_PACKAGE_JSON_SEARCH_DEPTH = 64;
const CHILD_OUTPUT_CAP_BYTES = 64 * 1024;

class WrapperError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new WrapperError(code, message, details);
}

function emitErrorAndExit(err) {
  const payload = {
    ok: false,
    error: {
      code: err instanceof WrapperError ? err.code : 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    },
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      fail('bad_args', `Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail('bad_args', `Missing value for --${key}`);
    }
    options[key] = value;
    i += 1;
  }
  return { command, options };
}

// ---------------------------------------------------------------------------
// Path / filesystem safety helpers
// ---------------------------------------------------------------------------

function hasDotDotSegment(relPath) {
  const normalized = relPath.split(/[\\/]+/);
  return normalized.some((segment) => segment === '..');
}

function isAbsoluteLike(candidate) {
  if (path.win32.isAbsolute(candidate)) return true;
  if (path.posix.isAbsolute(candidate)) return true;
  // Windows drive-letter or UNC style paths even on POSIX hosts.
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) return true;
  if (/^\\\\/.test(candidate)) return true;
  return false;
}

async function assertDirectoryExists(dirPath, code) {
  let st;
  try {
    st = await stat(dirPath);
  } catch {
    fail(code, `Directory does not exist: ${dirPath}`);
  }
  if (!st.isDirectory()) {
    fail(code, `Not a directory: ${dirPath}`);
  }
}

/**
 * Resolve every ancestor of `targetPath` (starting from the deepest existing
 * one) and confirm none of them is a symlink pointing outside `realBase`.
 * This must run BEFORE any mkdir/write so a pre-existing symlink escape is
 * rejected before any outside directory or file is created.
 */
async function assertLexicalAndRealAncestryInside(realBase, relFromBase, code) {
  if (path.isAbsolute(relFromBase)) {
    fail(code, `Expected a relative path: ${relFromBase}`);
  }
  if (hasDotDotSegment(relFromBase)) {
    fail(code, `Path traversal is not permitted: ${relFromBase}`);
  }
  const lexical = path.resolve(realBase, relFromBase);
  const relFromLexical = path.relative(realBase, lexical);
  if (relFromLexical.startsWith('..') || path.isAbsolute(relFromLexical)) {
    fail(code, `Path escapes target root: ${relFromBase}`);
  }

  const segments = relFromBase.split(/[\\/]+/).filter(Boolean);
  let cursor = realBase;
  for (const segment of segments) {
    const next = path.join(cursor, segment);
    let lst;
    try {
      lst = await lstat(next);
    } catch {
      // Does not exist yet at this depth: nothing further to check, and
      // nothing beyond this point can already be an escaping symlink.
      break;
    }
    if (lst.isSymbolicLink()) {
      let real;
      try {
        real = await realpath(next);
      } catch {
        fail(code, `Broken or unresolvable symlink in path: ${next}`);
      }
      const relReal = path.relative(realBase, real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        fail(code, `Symlink escapes target root: ${next} -> ${real}`);
      }
      cursor = real;
    } else {
      cursor = next;
    }
  }
  return lexical;
}

async function resolveArtifactRoot(realCwd, override) {
  const rel = override === undefined ? DEFAULT_ARTIFACT_ROOT : override;
  if (isAbsoluteLike(rel) || path.isAbsolute(rel)) {
    fail('artifact_root_invalid', 'Artifact root override must be a relative path');
  }
  if (hasDotDotSegment(rel)) {
    fail('artifact_root_invalid', 'Artifact root override must not contain ".." segments');
  }
  const lexical = await assertLexicalAndRealAncestryInside(realCwd, rel, 'artifact_root_invalid');

  await mkdir(lexical, { recursive: true });

  const realRoot = await realpath(lexical);
  const relCheck = path.relative(realCwd, realRoot);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    fail('artifact_root_invalid', 'Artifact root resolved outside target cwd after creation');
  }
  return realRoot;
}

/**
 * Pure syntactic validation of the caller-supplied --name, independent of
 * any filesystem state. Must run BEFORE the artifact root is resolved or
 * created, so a syntactically invalid name never causes any directory to
 * be created.
 */
function validateOutputNameSyntax(name) {
  if (typeof name !== 'string' || name.length === 0) {
    fail('output_name_invalid', 'Output --name is required');
  }
  if (isAbsoluteLike(name) || path.isAbsolute(name)) {
    fail('output_name_invalid', 'Output --name must be a relative path');
  }
  if (hasDotDotSegment(name)) {
    fail('output_name_invalid', 'Output --name must not contain ".." segments');
  }
  if (!name.toLowerCase().endsWith('.html')) {
    fail('output_name_invalid', 'Output --name must end with .html');
  }
}

async function resolveFinalPath(realArtifactRoot, name) {
  // Defensive re-check: callers are expected to have already run
  // validateOutputNameSyntax before creating the artifact root.
  validateOutputNameSyntax(name);

  const lexicalFinal = await assertLexicalAndRealAncestryInside(
    realArtifactRoot,
    name,
    'output_name_invalid',
  );

  const parentRel = path.dirname(name);
  if (parentRel !== '.') {
    await mkdir(path.dirname(lexicalFinal), { recursive: true });
  }

  const realParent = await realpath(path.dirname(lexicalFinal));
  const relParentCheck = path.relative(realArtifactRoot, realParent);
  if (relParentCheck.startsWith('..') || path.isAbsolute(relParentCheck)) {
    fail('output_name_invalid', 'Output parent directory resolved outside artifact root');
  }

  const finalPath = path.join(realParent, path.basename(lexicalFinal));
  return finalPath;
}

async function assertFinalReplaceable(finalPath) {
  let lst;
  try {
    lst = await lstat(finalPath);
  } catch {
    return; // Does not exist yet: fine, this will be a fresh delivery.
  }
  if (lst.isSymbolicLink()) {
    fail('final_not_replaceable', 'Final output path is a symlink; refusing to replace it');
  }
  if (!lst.isFile()) {
    fail('final_not_replaceable', 'Final output path exists and is not a regular file');
  }
}

function candidateNameFor(finalPath) {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath, path.extname(finalPath));
  const unique = randomBytes(9).toString('hex');
  return path.join(dir, `.${base}.${process.pid}.${unique}.candidate.html`);
}

// ---------------------------------------------------------------------------
// Runtime identity / doctor
// ---------------------------------------------------------------------------

async function checkRuntimeAvailable(runtimePath) {
  if (typeof runtimePath !== 'string' || runtimePath.length === 0) {
    return { available: false, reason: 'runtime_not_supplied' };
  }
  if (!path.isAbsolute(runtimePath)) {
    return { available: false, reason: 'runtime_not_absolute' };
  }
  let st;
  try {
    st = await stat(runtimePath);
  } catch {
    return { available: false, reason: 'runtime_not_found' };
  }
  if (!st.isFile()) {
    return { available: false, reason: 'runtime_not_regular_file' };
  }
  if (process.platform !== 'win32') {
    try {
      await access(runtimePath, fsConstants.X_OK);
    } catch {
      return { available: false, reason: 'runtime_not_executable' };
    }
  }
  return { available: true };
}

/**
 * Bounded upward search from the runtime's directory for a package.json,
 * used only to establish version identity. Never touches the network.
 */
async function detectRuntimeIdentity(runtimePath) {
  let dir = path.dirname(runtimePath);
  for (let depth = 0; depth < MAX_PACKAGE_JSON_SEARCH_DEPTH; depth += 1) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const raw = await readFile(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        const version = typeof parsed.version === 'string' ? parsed.version : null;
        if (version) {
          return version === ARCHIFY_EXPECTED_VERSION
            ? { status: 'verified', detectedVersion: version }
            : { status: 'mismatch', detectedVersion: version };
        }
      } catch {
        // Unreadable or malformed package.json: keep searching upward.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { status: 'unverified', detectedVersion: null };
}

async function runDoctor(options) {
  const cwdArg = options.cwd;
  const runtimeArg = options.runtime;

  const report = {
    ok: false,
    command: 'doctor',
    wrapperVersion: WRAPPER_VERSION,
    profileVersion: PROFILE_VERSION,
    archify: {
      pin: ARCHIFY_PIN,
      runtime: runtimeArg ?? null,
    },
  };

  if (typeof cwdArg !== 'string' || cwdArg.length === 0) {
    report.error = { code: 'cwd_invalid', message: '--cwd is required' };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await assertDirectoryExists(cwdArg, 'cwd_invalid');
    report.realCwd = await realpath(cwdArg);
  } catch (err) {
    report.error = {
      code: err instanceof WrapperError ? err.code : 'internal_error',
      message: err.message,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
    return;
  }

  const availability = await checkRuntimeAvailable(runtimeArg);
  report.archify.available = availability.available;
  if (!availability.available) {
    report.archify.identityStatus = 'unverified';
    report.archify.detectedVersion = null;
    report.archify.unavailableReason = availability.reason;
    report.ok = false;
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
    return;
  }

  const identity = await detectRuntimeIdentity(runtimeArg);
  report.archify.identityStatus = identity.status;
  report.archify.detectedVersion = identity.detectedVersion;
  report.ok = identity.status !== 'mismatch';
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

async function sha256AndBytes(filePath) {
  const buf = await readFile(filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { sha256, bytes: buf.length, buffer: buf };
}

function looksLikeBasicHtml(buffer) {
  const prefix = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html');
}

// ---------------------------------------------------------------------------
// Child process invocation
// ---------------------------------------------------------------------------

function runChild(runtimePath, args, childCwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtimePath, args, {
      cwd: childCwd,
      shell: false,
      env: {
        ...process.env,
        ARCHIFY_UPDATE_CHECK_DISABLED: '1',
      },
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < CHILD_OUTPUT_CAP_BYTES) {
        stdout = Buffer.concat([stdout, chunk]).subarray(0, CHILD_OUTPUT_CAP_BYTES);
      }
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < CHILD_OUTPUT_CAP_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, CHILD_OUTPUT_CAP_BYTES);
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// deliver command
// ---------------------------------------------------------------------------

async function runDeliver(options) {
  const { cwd: cwdArg, runtime: runtimeArg, type, spec: specArg, name, 'artifact-root': artifactRootArg } = options;

  if (typeof cwdArg !== 'string' || cwdArg.length === 0) {
    fail('cwd_invalid', '--cwd is required');
  }
  await assertDirectoryExists(cwdArg, 'cwd_invalid');
  const realCwd = await realpath(cwdArg);

  const availability = await checkRuntimeAvailable(runtimeArg);
  if (!availability.available) {
    fail('runtime_unavailable', `Runtime is not available: ${availability.reason}`);
  }

  const identity = await detectRuntimeIdentity(runtimeArg);
  if (identity.status === 'mismatch') {
    fail(
      'runtime_version_mismatch',
      `Runtime package version ${identity.detectedVersion} does not match required pin ${ARCHIFY_EXPECTED_VERSION}`,
    );
  }

  if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
    fail('type_invalid', `--type must be one of: ${[...VALID_TYPES].join(', ')}`);
  }

  // Pure syntactic --name validation must happen before the artifact root
  // is resolved/created, so a syntactically invalid name never causes any
  // directory creation.
  validateOutputNameSyntax(name);

  if (typeof specArg !== 'string' || specArg.length === 0) {
    fail('spec_invalid', '--spec is required');
  }
  const specPath = path.resolve(realCwd, specArg);
  let specStat;
  try {
    specStat = await stat(specPath);
  } catch {
    fail('spec_invalid', 'Spec file does not exist');
  }
  if (!specStat.isFile()) {
    fail('spec_invalid', 'Spec path is not a regular file');
  }
  const specDigest = await sha256AndBytes(specPath);

  const realArtifactRoot = await resolveArtifactRoot(realCwd, artifactRootArg);
  const finalPath = await resolveFinalPath(realArtifactRoot, name);
  await assertFinalReplaceable(finalPath);

  const candidatePath = candidateNameFor(finalPath);
  if (existsSync(candidatePath)) {
    fail('candidate_collision', 'Generated candidate path unexpectedly already exists');
  }

  const childArgs = ['deliver', type, specPath, candidatePath, '--json'];
  let childResult;
  try {
    childResult = await runChild(runtimeArg, childArgs, realCwd);
  } catch (err) {
    await rm(candidatePath, { force: true });
    fail('child_spawn_failed', `Failed to spawn archify runtime: ${err.message}`);
  }

  if (childResult.exitCode !== 0) {
    await rm(candidatePath, { force: true });
    fail(
      'child_failed',
      `Archify runtime exited with code ${childResult.exitCode}`,
      { stderrTail: childResult.stderr.subarray(-1024).toString('utf8') },
    );
  }

  let candidateLst;
  try {
    candidateLst = await lstat(candidatePath);
  } catch {
    fail('candidate_missing', 'Archify runtime exited 0 but produced no candidate file');
  }
  if (candidateLst.isSymbolicLink() || !candidateLst.isFile() || candidateLst.size === 0) {
    await rm(candidatePath, { force: true });
    fail('candidate_invalid', 'Candidate output is not a non-empty regular file');
  }

  const candidateDigest = await sha256AndBytes(candidatePath);
  const isBasicHtml = looksLikeBasicHtml(candidateDigest.buffer);
  if (!isBasicHtml) {
    await rm(candidatePath, { force: true });
    fail('candidate_not_html', 'Candidate output failed basic HTML validation');
  }

  try {
    await rename(candidatePath, finalPath);
  } catch (err) {
    await rm(candidatePath, { force: true });
    fail('promotion_failed', `Failed to promote candidate to final path: ${err.message}`);
  }

  const finalRelativePath = path.relative(realCwd, finalPath);

  const receipt = {
    ok: true,
    receiptVersion: '1.0.0',
    wrapperVersion: WRAPPER_VERSION,
    profileVersion: PROFILE_VERSION,
    archify: {
      pin: ARCHIFY_PIN,
      runtime: runtimeArg,
      identityStatus: identity.status,
      detectedVersion: identity.detectedVersion,
    },
    child: {
      exitCode: childResult.exitCode,
      updateCheckDisabled: true,
    },
    finalRelativePath,
    spec: { sha256: specDigest.sha256, bytes: specDigest.bytes },
    artifact: { sha256: candidateDigest.sha256, bytes: candidateDigest.bytes },
    validation: {
      basicArtifact: isBasicHtml ? 'passed' : 'failed',
    },
    claims: {
      deterministicSchema: 'not_separately_verified',
      runtimeBrowser: 'not_performed',
      perceptual: 'not_performed',
      human: 'not_performed',
    },
  };

  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'doctor') {
    await runDoctor(options);
    return;
  }
  if (command === 'deliver') {
    await runDeliver(options);
    return;
  }
  fail('bad_command', `Unknown command: ${command ?? '(none)'}`);
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === `file://${path.resolve(process.argv[1])}`;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main(process.argv.slice(2)).catch((err) => {
    emitErrorAndExit(err);
  });
}
