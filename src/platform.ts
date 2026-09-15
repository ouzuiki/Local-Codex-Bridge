import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import path from "node:path";

export type SupportedPlatform = "win32" | "darwin" | "linux";

export interface ManagedChildProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface AppServerSpawnPolicy {
  readonly shell: false;
  readonly windowsHide?: true;
}

export interface PlatformPolicy {
  readonly platform: SupportedPlatform;
  readonly nativeCwdDescription: string;
  validateCwd(value: string): string;
  appServerSpawnOptions(): AppServerSpawnPolicy;
  hasChildExited(child: ManagedChildProcess): boolean;
  softTerminateChild(child: ManagedChildProcess): void;
  hardTerminateChild(child: ManagedChildProcess): void;
}

export type WindowsTaskkillRunner = (
  executable: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => { readonly error?: Error; readonly status: number | null };

function childHasExited(child: ManagedChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function validateWindowsCwd(value: string): string {
  if (value.includes("\0")) {
    throw new Error("cwd contains a NUL character");
  }
  if (/^(?:\\\\|\/\/|\\\\[?.]\\|\\[?.]\\)/.test(value)) {
    throw new Error("cwd must not be a UNC or Windows device path");
  }
  if (!/^[A-Za-z]:[\\/]/.test(value) || !path.win32.isAbsolute(value)) {
    throw new Error("cwd must be an absolute Windows drive-letter path");
  }
  return path.win32.normalize(value);
}

function validateDarwinCwd(value: string): string {
  if (value.includes("\0")) {
    throw new Error("cwd contains a NUL character");
  }
  if (!path.posix.isAbsolute(value)) {
    throw new Error("cwd must be an absolute POSIX path on macOS");
  }
  return path.posix.normalize(value);
}

function validateLinuxCwd(value: string): string {
  if (value.includes("\0")) {
    throw new Error("cwd contains a NUL character");
  }
  if (!path.posix.isAbsolute(value)) {
    throw new Error("cwd must be an absolute POSIX path on Linux");
  }
  return path.posix.normalize(value);
}

const runTaskkill: WindowsTaskkillRunner = (executable, args, options) =>
  spawnSync(executable, [...args], options);

export function createWindowsPlatformPolicy(
  taskkillRunner: WindowsTaskkillRunner = runTaskkill,
): PlatformPolicy {
  return {
    platform: "win32",
    nativeCwdDescription: "absolute Windows drive-letter path",
    validateCwd: validateWindowsCwd,
    appServerSpawnOptions: () => ({ shell: false, windowsHide: true }),
    hasChildExited: childHasExited,
    softTerminateChild: (child) => {
      child.kill();
    },
    hardTerminateChild: (child) => {
      if (child.pid === undefined) {
        throw new Error("Cannot hard-terminate Codex app-server without a process id");
      }
      const result = taskkillRunner(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      if (result.error) {
        throw new Error(`Failed to run taskkill.exe: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(
          `taskkill.exe failed for Codex app-server pid ${child.pid} (status=${String(result.status)})`,
        );
      }
    },
  };
}

export const WINDOWS_PLATFORM_POLICY = createWindowsPlatformPolicy();

export const DARWIN_PLATFORM_POLICY: PlatformPolicy = {
  platform: "darwin",
  nativeCwdDescription: "absolute POSIX path on macOS",
  validateCwd: validateDarwinCwd,
  appServerSpawnOptions: () => ({ shell: false }),
  hasChildExited: childHasExited,
  softTerminateChild: (child) => {
    child.kill("SIGTERM");
  },
  hardTerminateChild: (child) => {
    child.kill("SIGKILL");
  },
};

export const LINUX_PLATFORM_POLICY: PlatformPolicy = {
  platform: "linux",
  nativeCwdDescription: "absolute POSIX path on Linux",
  validateCwd: validateLinuxCwd,
  appServerSpawnOptions: () => ({ shell: false }),
  hasChildExited: childHasExited,
  softTerminateChild: (child) => {
    child.kill("SIGTERM");
  },
  hardTerminateChild: (child) => {
    child.kill("SIGKILL");
  },
};

export function platformPolicyFor(
  platform: NodeJS.Platform = process.platform,
): PlatformPolicy {
  if (platform === "win32") {
    return WINDOWS_PLATFORM_POLICY;
  }
  if (platform === "darwin") {
    return DARWIN_PLATFORM_POLICY;
  }
  if (platform === "linux") {
    return LINUX_PLATFORM_POLICY;
  }
  throw new Error(
    `Unsupported platform ${platform}; Local Codex Bridge supports Windows, macOS, and Linux`,
  );
}
