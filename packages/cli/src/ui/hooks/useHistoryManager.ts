/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import type { HistoryItem } from '../types.js';
import type { ChatRecordingService } from '@google/gemini-cli-core/src/services/chatRecordingService.js';

// Type for the updater function passed to updateHistoryItem
type HistoryItemUpdater = (
  prevItem: HistoryItem,
) => Partial<Omit<HistoryItem, 'id'>>;

export interface UseHistoryManagerReturn {
  history: HistoryItem[];
  addItem: (
    itemData: Omit<HistoryItem, 'id'>,
    baseTimestamp?: number,
    isResuming?: boolean,
  ) => number; // Returns the generated ID
  addItems: (
    itemsData: Array<Omit<HistoryItem, 'id'>>,
    baseTimestamp?: number,
    isResuming?: boolean,
  ) => number[]; // Returns the generated IDs
  updateItem: (
    id: number,
    updates: Partial<Omit<HistoryItem, 'id'>> | HistoryItemUpdater,
  ) => void;
  clearItems: () => void;
  loadHistory: (newHistory: HistoryItem[]) => void;
}

/**
 * Custom hook to manage the chat history state.
 *
 * Encapsulates the history array, message ID generation, adding items,
 * updating items, and clearing the history.
 */
export function useHistory({
  chatRecordingService,
  initialItems = [],
}: {
  chatRecordingService?: ChatRecordingService | null;
  initialItems?: HistoryItem[];
} = {}): UseHistoryManagerReturn {
  const [history, setHistory] = useState<HistoryItem[]>(initialItems);
  const messageIdCounterRef = useRef(0);

  // Generates a unique message ID based on a timestamp and a counter.
  const getNextMessageId = useCallback((baseTimestamp: number): number => {
    messageIdCounterRef.current += 1;
    return baseTimestamp + messageIdCounterRef.current;
  }, []);

  const loadHistory = useCallback((newHistory: HistoryItem[]) => {
    setHistory(newHistory);
  }, []);

  // Adds multiple items to history atomically.
  const addItems = useCallback(
    (
      itemsData: Array<Omit<HistoryItem, 'id'>>,
      baseTimestamp: number = Date.now(),
      isResuming: boolean = false,
    ): number[] => {
      const newItems: HistoryItem[] = itemsData.map((itemData) => {
        const id = getNextMessageId(baseTimestamp);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return { ...itemData, id } as HistoryItem;
      });

      setHistory((prevHistory) => {
        let lastItem =
          prevHistory.length > 0 ? prevHistory[prevHistory.length - 1] : null;
        const filteredNewItems: HistoryItem[] = [];

        for (const newItem of newItems) {
          // Prevent adding duplicate consecutive user messages
          if (
            lastItem &&
            lastItem.type === 'user' &&
            newItem.type === 'user' &&
            lastItem.text === newItem.text
          ) {
            continue;
          }
          filteredNewItems.push(newItem);
          lastItem = newItem;
        }

        return [...prevHistory, ...filteredNewItems];
      });

      if (!isResuming && chatRecordingService) {
        for (const itemData of itemsData) {
          switch (itemData.type) {
            case 'compression':
            case 'info':
              chatRecordingService?.recordMessage({
                model: undefined,
                type: 'info',
                content: itemData.text ?? '',
              });
              break;
            case 'warning':
              chatRecordingService?.recordMessage({
                model: undefined,
                type: 'warning',
                content: itemData.text ?? '',
              });
              break;
            case 'error':
              chatRecordingService?.recordMessage({
                model: undefined,
                type: 'error',
                content: itemData.text ?? '',
              });
              break;
            case 'user':
            case 'gemini':
            case 'gemini_content':
              // Core conversation recording handled by GeminiChat.
              break;
            default:
              // Ignore the rest.
              break;
          }
        }
      }

      return newItems.map((item) => item.id);
    },
    [getNextMessageId, chatRecordingService],
  );

  // Adds a single item to the history state (wrapper around addItems).
  const addItem = useCallback(
    (
      itemData: Omit<HistoryItem, 'id'>,
      baseTimestamp: number = Date.now(),
      isResuming: boolean = false,
    ): number => {
      const ids = addItems([itemData], baseTimestamp, isResuming);
      return ids[0];
    },
    [addItems],
  );

  /**
   * Updates an existing history item identified by its ID.
   * @deprecated Prefer not to update history item directly as we are currently
   * rendering all history items in <Static /> for performance reasons. Only use
   * if ABSOLUTELY NECESSARY
   */
  //
  const updateItem = useCallback(
    (
      id: number,
      updates: Partial<Omit<HistoryItem, 'id'>> | HistoryItemUpdater,
    ) => {
      setHistory((prevHistory) =>
        prevHistory.map((item) => {
          if (item.id === id) {
            // Apply updates based on whether it's an object or a function
            const newUpdates =
              typeof updates === 'function' ? updates(item) : updates;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            return { ...item, ...newUpdates } as HistoryItem;
          }
          return item;
        }),
      );
    },
    [],
  );

  // Clears the entire history state and resets the ID counter.
  const clearItems = useCallback(() => {
    setHistory([]);
    messageIdCounterRef.current = 0;
  }, []);

  return useMemo(
    () => ({
      history,
      addItem,
      addItems,
      updateItem,
      clearItems,
      loadHistory,
    }),
    [history, addItem, addItems, updateItem, clearItems, loadHistory],
  );
}
