/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  A2AClientManager,
  type SendMessageResult,
} from './a2a-client-manager.js';
import type { AgentCard, Task } from '@a2a-js/sdk';
import type { AuthenticationHandler, Client } from '@a2a-js/sdk/client';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  createAuthenticatingFetchWithRetry,
  ClientFactoryOptions,
  RestTransportFactory,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { GrpcTransportFactory } from '@a2a-js/sdk/client/grpc';
import { debugLogger } from '../utils/debugLogger.js';

vi.mock('../utils/debugLogger.js', () => ({
  debugLogger: {
    debug: vi.fn(),
  },
}));

vi.mock('@a2a-js/sdk/client', () => {
  const ClientFactory = vi.fn();
  const DefaultAgentCardResolver = vi.fn();
  const RestTransportFactory = vi.fn();
  const JsonRpcTransportFactory = vi.fn();
  const ClientFactoryOptions = {
    default: {},
    createFrom: vi.fn(),
  };
  const createAuthenticatingFetchWithRetry = vi.fn();

  DefaultAgentCardResolver.prototype.resolve = vi.fn();
  ClientFactory.prototype.createFromUrl = vi.fn();

  return {
    ClientFactory,
    ClientFactoryOptions,
    DefaultAgentCardResolver,
    RestTransportFactory,
    JsonRpcTransportFactory,
    createAuthenticatingFetchWithRetry,
  };
});

vi.mock('@a2a-js/sdk/client/grpc', () => {
  const GrpcTransportFactory = vi.fn();
  return {
    GrpcTransportFactory,
  };
});

describe('A2AClientManager', () => {
  let manager: A2AClientManager;

  // Stable mocks initialized once
  const sendMessageStreamMock = vi.fn();
  const getTaskMock = vi.fn();
  const cancelTaskMock = vi.fn();
  const getAgentCardMock = vi.fn();
  const authFetchMock = vi.fn();

  const mockClient = {
    sendMessageStream: sendMessageStreamMock,
    getTask: getTaskMock,
    cancelTask: cancelTaskMock,
    getAgentCard: getAgentCardMock,
  } as unknown as Client;

  const mockAgentCard: Partial<AgentCard> = { name: 'TestAgent' };

  beforeEach(() => {
    vi.clearAllMocks();
    A2AClientManager.resetInstanceForTesting();
    manager = A2AClientManager.getInstance();

    // Default mock implementations
    getAgentCardMock.mockResolvedValue({
      ...mockAgentCard,
      url: 'http://test.agent/real/endpoint',
    } as AgentCard);

    vi.mocked(ClientFactory.prototype.createFromUrl).mockResolvedValue(
      mockClient,
    );

    vi.mocked(DefaultAgentCardResolver.prototype.resolve).mockResolvedValue({
      ...mockAgentCard,
      url: 'http://test.agent/real/endpoint',
    } as AgentCard);

    vi.mocked(ClientFactoryOptions.createFrom).mockImplementation(
      (_defaults, overrides) => overrides as ClientFactoryOptions,
    );

    vi.mocked(createAuthenticatingFetchWithRetry).mockReturnValue(
      authFetchMock,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('should enforce the singleton pattern', () => {
    const instance1 = A2AClientManager.getInstance();
    const instance2 = A2AClientManager.getInstance();
    expect(instance1).toBe(instance2);
  });

  describe('loadAgent', () => {
    it('should create and cache an A2AClient', async () => {
      const agentCard = await manager.loadAgent(
        'TestAgent',
        'http://test.agent/card',
      );
      expect(manager.getAgentCard('TestAgent')).toBe(agentCard);
      expect(manager.getClient('TestAgent')).toBeDefined();
    });

    it('should configure ClientFactory with REST, JSON-RPC, and gRPC transports', async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent/card');

      expect(ClientFactoryOptions.createFrom).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          transports: [
            expect.any(RestTransportFactory),
            expect.any(JsonRpcTransportFactory),
            expect.any(GrpcTransportFactory),
          ],
        }),
      );
    });

    it('should throw an error if an agent with the same name is already loaded', async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent/card');
      await expect(
        manager.loadAgent('TestAgent', 'http://another.agent/card'),
      ).rejects.toThrow("Agent with name 'TestAgent' is already loaded.");
    });

    it('should use native fetch by default', async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent/card');
      expect(createAuthenticatingFetchWithRetry).not.toHaveBeenCalled();
    });

    it('should use provided custom authentication handler', async () => {
      const customAuthHandler = {
        headers: vi.fn(),
        shouldRetryWithHeaders: vi.fn(),
      };
      await manager.loadAgent(
        'CustomAuthAgent',
        'http://custom.agent/card',
        customAuthHandler as unknown as AuthenticationHandler,
      );

      expect(createAuthenticatingFetchWithRetry).toHaveBeenCalledWith(
        expect.anything(),
        customAuthHandler,
      );
    });

    it('should log a debug message upon loading an agent', async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent/card');
      expect(debugLogger.debug).toHaveBeenCalledWith(
        "[A2AClientManager] Loaded agent 'TestAgent' from http://test.agent/card",
      );
    });

    it('should clear the cache', async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent/card');
      expect(manager.getAgentCard('TestAgent')).toBeDefined();
      expect(manager.getClient('TestAgent')).toBeDefined();

      manager.clearCache();

      expect(manager.getAgentCard('TestAgent')).toBeUndefined();
      expect(manager.getClient('TestAgent')).toBeUndefined();
      expect(debugLogger.debug).toHaveBeenCalledWith(
        '[A2AClientManager] Cache cleared.',
      );
    });
  });

  describe('sendMessageStream', () => {
    beforeEach(async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent');
    });

    it('should send a message and return a stream', async () => {
      const mockResult = {
        kind: 'message',
        messageId: 'a',
        parts: [],
        role: 'agent',
      } as SendMessageResult;

      sendMessageStreamMock.mockReturnValue(
        (async function* () {
          yield mockResult;
        })(),
      );

      const stream = manager.sendMessageStream('TestAgent', 'Hello');
      const results = [];
      for await (const res of stream) {
        results.push(res);
      }

      expect(results).toEqual([mockResult]);
      expect(sendMessageStreamMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.anything(),
        }),
        expect.any(Object),
      );
    });

    it('should use contextId and taskId when provided', async () => {
      sendMessageStreamMock.mockReturnValue(
        (async function* () {
          yield {
            kind: 'message',
            messageId: 'a',
            parts: [],
            role: 'agent',
          } as SendMessageResult;
        })(),
      );

      const expectedContextId = 'user-context-id';
      const expectedTaskId = 'user-task-id';

      const stream = manager.sendMessageStream('TestAgent', 'Hello', {
        contextId: expectedContextId,
        taskId: expectedTaskId,
      });

      for await (const _ of stream) {
        // consume stream
      }

      const call = sendMessageStreamMock.mock.calls[0][0];
      expect(call.message.contextId).toBe(expectedContextId);
      expect(call.message.taskId).toBe(expectedTaskId);
    });

    it('should correctly propagate AbortSignal to the stream', async () => {
      const controller = new AbortController();
      sendMessageStreamMock.mockReturnValue(
        (async function* () {
          yield {
            kind: 'message',
            messageId: 'a',
            parts: [{ kind: 'text', text: 'Hi' }],
            role: 'agent',
          } as SendMessageResult;
        })(),
      );

      const stream = manager.sendMessageStream('TestAgent', 'Hello', {
        signal: controller.signal,
      });
      for await (const _ of stream) {
        // consume
      }

      expect(sendMessageStreamMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('should handle a multi-chunk stream with different event types', async () => {
      const chunks: SendMessageResult[] = [
        {
          kind: 'status-update',
          taskId: 't1',
          status: {
            state: 'working',
            message: {
              kind: 'message',
              role: 'agent',
              messageId: 'm1',
              parts: [{ kind: 'text', text: 'Thinking...' }],
            },
          },
        } as SendMessageResult,
        {
          kind: 'message',
          messageId: 'm2',
          role: 'agent',
          parts: [{ kind: 'text', text: 'Step 1' }],
        } as SendMessageResult,
        {
          kind: 'artifact-update',
          taskId: 't1',
          artifact: {
            artifactId: 'art1',
            parts: [{ kind: 'text', text: 'Data' }],
          },
        } as SendMessageResult,
      ];

      sendMessageStreamMock.mockReturnValue(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })(),
      );

      const stream = manager.sendMessageStream('TestAgent', 'Hello');
      const results = [];
      for await (const res of stream) {
        results.push(res);
      }

      expect(results).toHaveLength(3);
      expect(results[0].kind).toBe('status-update');
      expect(results[1].kind).toBe('message');
      expect(results[2].kind).toBe('artifact-update');
    });

    it('should throw prefixed error on failure', async () => {
      sendMessageStreamMock.mockImplementationOnce(() => {
        throw new Error('Network error');
      });

      const stream = manager.sendMessageStream('TestAgent', 'Hello');
      await expect(async () => {
        for await (const _ of stream) {
          // consume
        }
      }).rejects.toThrow(
        '[A2AClientManager] sendMessageStream Error [TestAgent]: Network error',
      );
    });

    it('should throw an error if the agent is not found', async () => {
      const stream = manager.sendMessageStream('NonExistentAgent', 'Hello');
      await expect(async () => {
        for await (const _ of stream) {
          // consume
        }
      }).rejects.toThrow("Agent 'NonExistentAgent' not found.");
    });
  });

  describe('getTask', () => {
    beforeEach(async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent');
    });

    it('should get a task from the correct agent', async () => {
      getTaskMock.mockResolvedValue({
        id: 'task123',
        contextId: 'a',
        kind: 'task',
        status: { state: 'completed' },
      } as Task);

      await manager.getTask('TestAgent', 'task123');
      expect(getTaskMock).toHaveBeenCalledWith({
        id: 'task123',
      });
    });

    it('should throw prefixed error on failure', async () => {
      getTaskMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(manager.getTask('TestAgent', 'task123')).rejects.toThrow(
        'A2AClient getTask Error [TestAgent]: Network error',
      );
    });

    it('should throw an error if the agent is not found', async () => {
      await expect(
        manager.getTask('NonExistentAgent', 'task123'),
      ).rejects.toThrow("Agent 'NonExistentAgent' not found.");
    });
  });

  describe('cancelTask', () => {
    beforeEach(async () => {
      await manager.loadAgent('TestAgent', 'http://test.agent');
    });

    it('should cancel a task on the correct agent', async () => {
      cancelTaskMock.mockResolvedValue({
        id: 'task123',
        contextId: 'a',
        kind: 'task',
        status: { state: 'canceled' },
      } as Task);

      await manager.cancelTask('TestAgent', 'task123');
      expect(cancelTaskMock).toHaveBeenCalledWith({
        id: 'task123',
      });
    });

    it('should throw prefixed error on failure', async () => {
      cancelTaskMock.mockRejectedValueOnce(new Error('Network error'));

      await expect(manager.cancelTask('TestAgent', 'task123')).rejects.toThrow(
        'A2AClient cancelTask Error [TestAgent]: Network error',
      );
    });

    it('should throw an error if the agent is not found', async () => {
      await expect(
        manager.cancelTask('NonExistentAgent', 'task123'),
      ).rejects.toThrow("Agent 'NonExistentAgent' not found.");
    });
  });
});
