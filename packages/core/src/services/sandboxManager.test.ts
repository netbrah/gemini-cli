/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  NoopSandboxManager,
  LocalSandboxManager,
  createSandboxManager,
} from './sandboxManager.js';

describe('NoopSandboxManager', () => {
  const sandboxManager = new NoopSandboxManager();

  it('should pass through the command and arguments unchanged', async () => {
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
    };

    const result = await sandboxManager.prepareCommand(req);

    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la']);
  });

  it('should sanitize the environment variables', async () => {
    const req = {
      command: 'echo',
      args: ['hello'],
      cwd: '/tmp',
      env: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        MY_SECRET: 'super-secret',
        SAFE_VAR: 'is-safe',
      },
    };

    const result = await sandboxManager.prepareCommand(req);

    expect(result.env['PATH']).toBe('/usr/bin');
    expect(result.env['SAFE_VAR']).toBe('is-safe');
    expect(result.env['GITHUB_TOKEN']).toBeUndefined();
    expect(result.env['MY_SECRET']).toBeUndefined();
  });

  it('should force environment variable redaction even if not requested in config', async () => {
    const req = {
      command: 'echo',
      args: ['hello'],
      cwd: '/tmp',
      env: {
        API_KEY: 'sensitive-key',
      },
      config: {
        sanitizationConfig: {
          enableEnvironmentVariableRedaction: false,
        },
      },
    };

    const result = await sandboxManager.prepareCommand(req);

    expect(result.env['API_KEY']).toBeUndefined();
  });

  it('should respect allowedEnvironmentVariables in config', async () => {
    const req = {
      command: 'echo',
      args: ['hello'],
      cwd: '/tmp',
      env: {
        MY_TOKEN: 'secret-token',
        OTHER_SECRET: 'another-secret',
      },
      config: {
        sanitizationConfig: {
          allowedEnvironmentVariables: ['MY_TOKEN'],
        },
      },
    };

    const result = await sandboxManager.prepareCommand(req);

    expect(result.env['MY_TOKEN']).toBe('secret-token');
    expect(result.env['OTHER_SECRET']).toBeUndefined();
  });

  it('should respect blockedEnvironmentVariables in config', async () => {
    const req = {
      command: 'echo',
      args: ['hello'],
      cwd: '/tmp',
      env: {
        SAFE_VAR: 'safe-value',
        BLOCKED_VAR: 'blocked-value',
      },
      config: {
        sanitizationConfig: {
          blockedEnvironmentVariables: ['BLOCKED_VAR'],
        },
      },
    };

    const result = await sandboxManager.prepareCommand(req);

    expect(result.env['SAFE_VAR']).toBe('safe-value');
    expect(result.env['BLOCKED_VAR']).toBeUndefined();
  });
});

const { mockedOsPlatform, mockedExecSync, mockedFsExistsSync } = vi.hoisted(
  () => ({
    mockedOsPlatform: vi.fn(),
    mockedExecSync: vi.fn(),
    mockedFsExistsSync: vi.fn().mockReturnValue(false),
  }),
);

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      platform: mockedOsPlatform,
      tmpdir: () => '/tmp',
      homedir: () => '/home/testuser',
    },
    platform: mockedOsPlatform,
    tmpdir: () => '/tmp',
    homedir: () => '/home/testuser',
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: mockedExecSync,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      realpathSync: (p: string) => p,
      existsSync: mockedFsExistsSync,
    },
  };
});

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: {
    warn: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
  },
}));

describe('LocalSandboxManager', () => {
  beforeEach(() => {
    vi.stubEnv('SANDBOX', '');
    vi.stubEnv('SEATBELT_PROFILE', '');
    vi.stubEnv('SEATBELT_PROFILE_PATH', '');
    mockedOsPlatform.mockReturnValue('linux');
    mockedExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    mockedFsExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should sanitize environment variables', async () => {
    const manager = new LocalSandboxManager();
    const req = {
      command: 'echo',
      args: ['hello'],
      cwd: '/tmp',
      env: {
        PATH: '/usr/bin',
        GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        SAFE_VAR: 'is-safe',
      },
    };

    const result = await manager.prepareCommand(req);

    expect(result.env['PATH']).toBe('/usr/bin');
    expect(result.env['SAFE_VAR']).toBe('is-safe');
    expect(result.env['GITHUB_TOKEN']).toBeUndefined();
  });

  it('should passthrough when SANDBOX env is set', async () => {
    vi.stubEnv('SANDBOX', 'docker-container');
    const manager = new LocalSandboxManager();
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la']);
    expect(result.cwd).toBe('/workspace');
  });

  it('should wrap command with sandbox-exec on macOS when available', async () => {
    mockedOsPlatform.mockReturnValue('darwin');
    mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/sandbox-exec'));
    const manager = new LocalSandboxManager();
    const req = {
      command: 'cat',
      args: ['file.txt'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('sandbox-exec');
    expect(result.args).toContain('-f');
    expect(result.args).toContain('cat');
    expect(result.args).toContain('file.txt');
    // Verify -D arguments for TARGET_DIR, TMP_DIR, HOME_DIR
    const targetDirIdx = result.args.indexOf('-D');
    expect(targetDirIdx).toBeGreaterThanOrEqual(0);
    expect(result.args).toContain(`TARGET_DIR=/workspace`);
    expect(result.args).toContain(`TMP_DIR=/tmp`);
    expect(result.args).toContain(`HOME_DIR=/home/testuser`);
    expect(result.cwd).toBe('/workspace');
  });

  it('should use sandbox-exec when sandboxConfig.command is sandbox-exec', async () => {
    mockedOsPlatform.mockReturnValue('darwin');
    mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/sandbox-exec'));
    const manager = new LocalSandboxManager({
      enabled: true,
      command: 'sandbox-exec',
    });
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('sandbox-exec');
  });

  it('should use custom seatbelt profile from SEATBELT_PROFILE env', async () => {
    mockedOsPlatform.mockReturnValue('darwin');
    mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/sandbox-exec'));
    vi.stubEnv('SEATBELT_PROFILE', 'restrictive-open');
    mockedFsExistsSync.mockReturnValue(false);

    const manager = new LocalSandboxManager();
    const req = {
      command: 'cat',
      args: ['file.txt'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('sandbox-exec');
    expect(result.args).toContain('-f');
    expect(result.args).toContain('sandbox-macos-restrictive-open.sb');
  });

  it('should use SEATBELT_PROFILE_PATH if set', async () => {
    mockedOsPlatform.mockReturnValue('darwin');
    mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/sandbox-exec'));
    vi.stubEnv('SEATBELT_PROFILE_PATH', '/custom/path/my-profile.sb');

    const manager = new LocalSandboxManager();
    const req = {
      command: 'cat',
      args: ['file.txt'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('sandbox-exec');
    expect(result.args).toContain('-f');
    expect(result.args).toContain('/custom/path/my-profile.sb');
  });

  it('should use home directory profile if it exists', async () => {
    mockedOsPlatform.mockReturnValue('darwin');
    mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/sandbox-exec'));
    mockedFsExistsSync.mockReturnValue(true);

    const manager = new LocalSandboxManager();
    const req = {
      command: 'cat',
      args: ['file.txt'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('sandbox-exec');
    expect(result.args).toContain('-f');
    expect(result.args).toContain(
      '/home/testuser/.gemini/sandbox-macos-permissive-open.sb',
    );
  });

  it('should fallback to passthrough when no sandbox backend is available', async () => {
    mockedOsPlatform.mockReturnValue('linux');
    const { debugLogger } = await import('../utils/debugLogger.js');
    const manager = new LocalSandboxManager();
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la']);
    expect(result.cwd).toBe('/workspace');
    expect(debugLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no sandbox backend is available'),
    );
  });

  it('should respect allowedEnvironmentVariables', async () => {
    const manager = new LocalSandboxManager();
    const req = {
      command: 'echo',
      args: ['hello'],
      cwd: '/tmp',
      env: {
        MY_TOKEN: 'secret-token',
        OTHER_SECRET: 'another-secret',
      },
      config: {
        sanitizationConfig: {
          allowedEnvironmentVariables: ['MY_TOKEN'],
        },
      },
    };

    const result = await manager.prepareCommand(req);

    expect(result.env['MY_TOKEN']).toBe('secret-token');
    expect(result.env['OTHER_SECRET']).toBeUndefined();
  });

  it('should set cwd on the returned SandboxedCommand', async () => {
    const manager = new LocalSandboxManager();
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/my/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.cwd).toBe('/my/workspace');
  });

  it('should not use sandbox-exec on macOS when command does not exist', async () => {
    mockedOsPlatform.mockReturnValue('darwin');
    // execSync throws => command not found
    const manager = new LocalSandboxManager();
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    // Falls through to passthrough
    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la']);
  });

  it('should wrap command with bwrap on Linux when available', async () => {
    mockedOsPlatform.mockReturnValue('linux');
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('bwrap')) {
        return Buffer.from('/usr/bin/bwrap');
      }
      throw new Error('command not found');
    });
    const manager = new LocalSandboxManager();
    const req = {
      command: 'grep',
      args: ['-r', 'foo'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('bwrap');
    // Verify lifecycle flags
    expect(result.args).toContain('--new-session');
    expect(result.args).toContain('--die-with-parent');
    // Verify read-only root
    const roBindIdx = result.args.indexOf('--ro-bind');
    expect(roBindIdx).toBeGreaterThanOrEqual(0);
    expect(result.args[roBindIdx + 1]).toBe('/');
    expect(result.args[roBindIdx + 2]).toBe('/');
    // Verify writable carve-outs appear as --bind <path> <path> triplets
    const bindIndices = result.args.reduce<number[]>((acc, arg, i) => {
      if (arg === '--bind') acc.push(i);
      return acc;
    }, []);
    const bindPaths = bindIndices.map((i) => result.args[i + 1]);
    expect(bindPaths).toContain('/workspace');
    expect(bindPaths).toContain('/tmp');
    expect(bindPaths).toContain('/home/testuser');
    // Verify namespace isolation
    expect(result.args).toContain('--unshare-user');
    expect(result.args).toContain('--unshare-pid');
    // Verify network isolation (default: no network)
    expect(result.args).toContain('--unshare-net');
    // Verify /proc and /dev
    expect(result.args).toContain('--proc');
    expect(result.args).toContain('--dev');
    // Verify separator and original command
    const separatorIdx = result.args.indexOf('--');
    expect(separatorIdx).toBeGreaterThan(0);
    expect(result.args[separatorIdx + 1]).toBe('grep');
    expect(result.args[separatorIdx + 2]).toBe('-r');
    expect(result.args[separatorIdx + 3]).toBe('foo');
    expect(result.cwd).toBe('/workspace');
  });

  it('should allow network access in bwrap when networkAccess is true', async () => {
    mockedOsPlatform.mockReturnValue('linux');
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('bwrap')) {
        return Buffer.from('/usr/bin/bwrap');
      }
      throw new Error('command not found');
    });
    const manager = new LocalSandboxManager({
      enabled: true,
      networkAccess: true,
    });
    const req = {
      command: 'curl',
      args: ['https://example.com'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('bwrap');
    expect(result.args).not.toContain('--unshare-net');
  });

  it('should add writable binds for allowedPaths in bwrap', async () => {
    mockedOsPlatform.mockReturnValue('linux');
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('bwrap')) {
        return Buffer.from('/usr/bin/bwrap');
      }
      throw new Error('command not found');
    });
    const manager = new LocalSandboxManager({
      enabled: true,
      allowedPaths: ['/data/shared', '/opt/tools'],
    });
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    expect(result.program).toBe('bwrap');
    // Check that allowed paths appear as --bind arguments
    const args = result.args;
    const bindIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === '--bind') acc.push(i);
      return acc;
    }, []);
    // 5 binds: cwd + tmp + home + 2 allowedPaths (/data/shared, /opt/tools)
    expect(bindIndices.length).toBe(5);
    // Verify allowed paths appear as --bind <path> <path> triplets
    const bindArgs = bindIndices.map((i) => args[i + 1]);
    expect(bindArgs).toContain('/data/shared');
    expect(bindArgs).toContain('/opt/tools');
  });

  it('should not use bwrap on Linux when command does not exist', async () => {
    mockedOsPlatform.mockReturnValue('linux');
    // execSync throws for all commands => bwrap not found
    const manager = new LocalSandboxManager();
    const req = {
      command: 'ls',
      args: ['-la'],
      cwd: '/workspace',
      env: { PATH: '/usr/bin' },
    };

    const result = await manager.prepareCommand(req);

    // Falls through to passthrough
    expect(result.program).toBe('ls');
    expect(result.args).toEqual(['-la']);
  });
});

describe('createSandboxManager', () => {
  it('should return NoopSandboxManager when sandboxing is disabled', () => {
    const manager = createSandboxManager(false);
    expect(manager).toBeInstanceOf(NoopSandboxManager);
  });

  it('should return LocalSandboxManager when sandboxing is enabled', () => {
    const manager = createSandboxManager(true);
    expect(manager).toBeInstanceOf(LocalSandboxManager);
  });

  it('should pass sandboxConfig to LocalSandboxManager', () => {
    const config = { enabled: true, command: 'sandbox-exec' as const };
    const manager = createSandboxManager(true, config);
    // The LocalSandboxManager receives the full SandboxConfig but the
    // sandboxing-enabled decision is made by the factory, not the manager.
    expect(manager).toBeInstanceOf(LocalSandboxManager);
  });
});
