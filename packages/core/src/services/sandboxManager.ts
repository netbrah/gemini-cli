/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os, { homedir } from 'node:os';

import type { SandboxConfig } from '../config/config.js';
import { debugLogger } from '../utils/debugLogger.js';

import {
  sanitizeEnvironment,
  type EnvironmentSanitizationConfig,
} from './environmentSanitization.js';

/**
 * Request for preparing a command to run in a sandbox.
 */
export interface SandboxRequest {
  /** The program to execute. */
  command: string;
  /** Arguments for the program. */
  args: string[];
  /** The working directory. */
  cwd: string;
  /** Environment variables to be passed to the program. */
  env: NodeJS.ProcessEnv;
  /** Optional sandbox-specific configuration. */
  config?: {
    sanitizationConfig?: Partial<EnvironmentSanitizationConfig>;
  };
}

/**
 * A command that has been prepared for sandboxed execution.
 */
export interface SandboxedCommand {
  /** The program or wrapper to execute. */
  program: string;
  /** Final arguments for the program. */
  args: string[];
  /** Sanitized environment variables. */
  env: NodeJS.ProcessEnv;
  /** Working directory for the command. */
  cwd?: string;
}

/**
 * Interface for a service that prepares commands for sandboxed execution.
 */
export interface SandboxManager {
  /**
   * Prepares a command to run in a sandbox, including environment sanitization.
   */
  prepareCommand(req: SandboxRequest): Promise<SandboxedCommand>;
}

/**
 * Shared helper to sanitize environment variables from a SandboxRequest.
 */
function sanitizeRequestEnv(req: SandboxRequest): NodeJS.ProcessEnv {
  const sanitizationConfig: EnvironmentSanitizationConfig = {
    allowedEnvironmentVariables:
      req.config?.sanitizationConfig?.allowedEnvironmentVariables ?? [],
    blockedEnvironmentVariables:
      req.config?.sanitizationConfig?.blockedEnvironmentVariables ?? [],
    enableEnvironmentVariableRedaction: true, // Forced for safety
  };
  return sanitizeEnvironment(req.env, sanitizationConfig);
}

/**
 * Checks if a command exists on the system PATH.
 * The command name is validated to contain only safe characters.
 */
function commandExists(cmd: string): boolean {
  // Validate command name contains only alphanumeric, hyphen, underscore, dot
  if (!/^[a-zA-Z0-9_.-]+$/.test(cmd)) {
    return false;
  }
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A no-op implementation of SandboxManager that silently passes commands
 * through while applying environment sanitization.
 */
export class NoopSandboxManager implements SandboxManager {
  /**
   * Prepares a command by sanitizing the environment and passing through
   * the original program and arguments.
   */
  async prepareCommand(req: SandboxRequest): Promise<SandboxedCommand> {
    const sanitizedEnv = sanitizeRequestEnv(req);

    return {
      program: req.command,
      args: req.args,
      env: sanitizedEnv,
    };
  }
}

/**
 * A sandbox manager that wraps tool commands in platform-appropriate sandbox
 * execution. On macOS, uses Seatbelt (sandbox-exec). Falls back to
 * environment sanitization only when no sandbox backend is available.
 */
export class LocalSandboxManager implements SandboxManager {
  private readonly sandboxConfig?: SandboxConfig;

  constructor(sandboxConfig?: SandboxConfig) {
    this.sandboxConfig = sandboxConfig;
  }

  async prepareCommand(req: SandboxRequest): Promise<SandboxedCommand> {
    const sanitizedEnv = sanitizeRequestEnv(req);

    // If already inside a sandbox, passthrough without double-sandboxing
    if (process.env['SANDBOX']) {
      return {
        program: req.command,
        args: req.args,
        env: sanitizedEnv,
        cwd: req.cwd,
      };
    }

    const platform = os.platform();
    const sandboxCommand = this.sandboxConfig?.command;

    // macOS Seatbelt
    if (
      (sandboxCommand === 'sandbox-exec' ||
        (!sandboxCommand && platform === 'darwin')) &&
      commandExists('sandbox-exec')
    ) {
      return this.prepareSeatbeltCommand(req, sanitizedEnv);
    }

    // Linux bubblewrap (bwrap)
    if (!sandboxCommand && platform === 'linux' && commandExists('bwrap')) {
      return this.prepareBwrapCommand(req, sanitizedEnv);
    }

    // Fallback: sanitization only with warning
    return this.preparePassthroughCommand(req, sanitizedEnv);
  }

  private prepareSeatbeltCommand(
    req: SandboxRequest,
    sanitizedEnv: NodeJS.ProcessEnv,
  ): SandboxedCommand {
    const profile = process.env['SEATBELT_PROFILE'] || 'permissive-open';

    const profilePath = this.resolveSeatbeltProfile(profile);

    let resolvedCwd: string;
    try {
      resolvedCwd = fs.realpathSync(req.cwd);
    } catch {
      resolvedCwd = req.cwd;
    }

    let resolvedTmp: string;
    try {
      resolvedTmp = fs.realpathSync(os.tmpdir());
    } catch {
      resolvedTmp = os.tmpdir();
    }

    let resolvedHome: string;
    try {
      resolvedHome = fs.realpathSync(homedir());
    } catch {
      resolvedHome = homedir();
    }

    const seatbeltArgs = [
      '-D',
      `TARGET_DIR=${resolvedCwd}`,
      '-D',
      `TMP_DIR=${resolvedTmp}`,
      '-D',
      `HOME_DIR=${resolvedHome}`,
      '-f',
      profilePath,
      req.command,
      ...req.args,
    ];

    return {
      program: 'sandbox-exec',
      args: seatbeltArgs,
      env: sanitizedEnv,
      cwd: req.cwd,
    };
  }

  private resolveSeatbeltProfile(profile: string): string {
    // If an explicit profile path is provided via the SEATBELT_PROFILE_PATH
    // environment variable, use it directly.
    const explicitPath = process.env['SEATBELT_PROFILE_PATH'];
    if (explicitPath) {
      return explicitPath;
    }

    // Default to a well-known filename pattern. The actual .sb files live in
    // packages/cli/src/utils/ but at runtime they are resolved relative to the
    // CLI entry point. For tool-level sandboxing in core, we look for the
    // profile in the Gemini project settings directory (~/.gemini/) or fall
    // back to just the profile name which sandbox-exec may resolve itself.
    const homeProfilePath = `${homedir()}/.gemini/sandbox-macos-${profile}.sb`;
    if (fs.existsSync(homeProfilePath)) {
      return homeProfilePath;
    }

    // Fallback: return the profile filename — sandbox-exec may find it
    // in the current directory or via its own search path.
    return `sandbox-macos-${profile}.sb`;
  }

  /**
   * Wraps a command using bubblewrap (bwrap) for Linux namespace-based
   * sandboxing. Based on the pattern from Codex's linux-sandbox implementation:
   *   bwrap --new-session --die-with-parent <mounts>
   *         --unshare-user --unshare-pid [--unshare-net]
   *         --proc /proc --dev /dev -- <command> <args>
   *
   * The filesystem view is:
   *   - Read-only bind of the root filesystem (--ro-bind / /)
   *   - Writable bind of the working directory
   *   - Writable bind of /tmp
   *   - Writable bind of HOME
   *   - Writable binds for any configured allowedPaths
   *   - Fresh /proc and /dev mounts
   */
  private prepareBwrapCommand(
    req: SandboxRequest,
    sanitizedEnv: NodeJS.ProcessEnv,
  ): SandboxedCommand {
    // Resolve symlinks for mount paths; fall back to the raw path if
    // realpathSync fails (e.g. path doesn't exist yet).
    let resolvedCwd: string;
    try {
      resolvedCwd = fs.realpathSync(req.cwd);
    } catch {
      resolvedCwd = req.cwd;
    }

    let resolvedTmp: string;
    try {
      resolvedTmp = fs.realpathSync(os.tmpdir());
    } catch {
      resolvedTmp = os.tmpdir();
    }

    let resolvedHome: string;
    try {
      resolvedHome = fs.realpathSync(homedir());
    } catch {
      resolvedHome = homedir();
    }

    const bwrapArgs: string[] = [
      // Session and lifecycle isolation
      '--new-session',
      '--die-with-parent',

      // Read-only root filesystem
      '--ro-bind',
      '/',
      '/',

      // Writable carve-outs
      '--bind',
      resolvedCwd,
      resolvedCwd,
      '--bind',
      resolvedTmp,
      resolvedTmp,
      '--bind',
      resolvedHome,
      resolvedHome,
    ];

    // Add writable binds for configured allowed paths
    const allowedPaths = this.sandboxConfig?.allowedPaths ?? [];
    for (const allowedPath of allowedPaths) {
      let resolved: string;
      try {
        resolved = fs.realpathSync(allowedPath);
      } catch {
        resolved = allowedPath;
      }
      bwrapArgs.push('--bind', resolved, resolved);
    }

    // Namespace isolation
    bwrapArgs.push('--unshare-user', '--unshare-pid');

    // Network isolation (disable network unless explicitly allowed)
    if (!this.sandboxConfig?.networkAccess) {
      bwrapArgs.push('--unshare-net');
    }

    // Fresh /proc and /dev mounts
    bwrapArgs.push('--proc', '/proc', '--dev', '/dev');

    // Separator and the actual command
    bwrapArgs.push('--', req.command, ...req.args);

    return {
      program: 'bwrap',
      args: bwrapArgs,
      env: sanitizedEnv,
      cwd: req.cwd,
    };
  }

  private preparePassthroughCommand(
    req: SandboxRequest,
    sanitizedEnv: NodeJS.ProcessEnv,
  ): SandboxedCommand {
    debugLogger.warn(
      'Tool sandboxing is enabled but no sandbox backend is available. ' +
        'Commands will run with environment sanitization only.',
    );
    return {
      program: req.command,
      args: req.args,
      env: sanitizedEnv,
      cwd: req.cwd,
    };
  }
}

/**
 * Factory function to create the appropriate SandboxManager based on config.
 */
export function createSandboxManager(
  sandboxingEnabled: boolean,
  sandboxConfig?: SandboxConfig,
): SandboxManager {
  if (sandboxingEnabled) {
    return new LocalSandboxManager(sandboxConfig);
  }
  return new NoopSandboxManager();
}
