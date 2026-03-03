/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, Fragment } from 'react';
import { Box, Text } from 'ink';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../../types.js';
import { ToolCallStatus, mapCoreStatusToDisplayStatus } from '../../types.js';
import { ToolMessage } from './ToolMessage.js';
import { ShellToolMessage } from './ShellToolMessage.js';
import { DenseToolMessage } from './DenseToolMessage.js';
import { theme } from '../../semantic-colors.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { isShellTool, isThisShellFocused } from './ToolShared.js';
import {
  shouldHideToolCall,
  CoreToolCallStatus,
  EDIT_DISPLAY_NAME,
  GLOB_DISPLAY_NAME,
  WEB_SEARCH_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  LS_DISPLAY_NAME,
  GREP_DISPLAY_NAME,
  WEB_FETCH_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  READ_MANY_FILES_DISPLAY_NAME,
} from '@google/gemini-cli-core';
import { ShowMoreLines } from '../ShowMoreLines.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useAlternateBuffer } from '../../hooks/useAlternateBuffer.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import {
  calculateShellMaxLines,
  calculateToolContentMaxLines,
} from '../../utils/toolLayoutUtils.js';
import { getToolGroupBorderAppearance } from '../../utils/borderStyles.js';

const COMPACT_OUTPUT_ALLOWLIST = new Set([
  EDIT_DISPLAY_NAME,
  GLOB_DISPLAY_NAME,
  WEB_SEARCH_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  LS_DISPLAY_NAME,
  GREP_DISPLAY_NAME,
  WEB_FETCH_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  READ_MANY_FILES_DISPLAY_NAME,
]);

interface ToolGroupMessageProps {
  item: HistoryItem | HistoryItemWithoutId;
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  terminalWidth: number;
  onShellInputSubmit?: (input: string) => void;
  borderTop?: boolean;
  borderBottom?: boolean;
  isExpandable?: boolean;
}

// Main component renders the border and maps the tools using ToolMessage
const TOOL_MESSAGE_HORIZONTAL_MARGIN = 4;

// Helper to identify if a tool should use the compact view
const isCompactTool = (
  tool: IndividualToolCallDisplay,
  isCompactModeEnabled: boolean,
): boolean => {
  const hasCompactOutputSupport = COMPACT_OUTPUT_ALLOWLIST.has(tool.name);
  const displayStatus = mapCoreStatusToDisplayStatus(tool.status);
  return (
    isCompactModeEnabled &&
    hasCompactOutputSupport &&
    displayStatus !== ToolCallStatus.Confirming
  );
};

const COMPACT_TOOL_VIEW = 'compact tool view';
const STANDARD_TOOL_VIEW = 'standard tool view';

type ToolSegment = {
  type: typeof COMPACT_TOOL_VIEW | typeof STANDARD_TOOL_VIEW;
  tools: IndividualToolCallDisplay[];
};

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  item,
  toolCalls: allToolCalls,
  availableTerminalHeight,
  terminalWidth,
  borderTop: borderTopOverride,
  borderBottom: borderBottomOverride,
  isExpandable,
}) => {
  const settings = useSettings();
  const isCompactModeEnabled = settings.merged.ui?.compactToolOutput === true;
  const isLowErrorVerbosity = settings.merged.ui?.errorVerbosity !== 'full';

  // Filter out tool calls that should be hidden (e.g. in-progress Ask User, or Plan Mode operations).
  const toolCalls = useMemo(
    () =>
      allToolCalls.filter((t) => {
        if (
          isLowErrorVerbosity &&
          t.status === CoreToolCallStatus.Error &&
          !t.isClientInitiated
        ) {
          return false;
        }

        return !shouldHideToolCall({
          displayName: t.name,
          status: t.status,
          approvalMode: t.approvalMode,
          hasResultDisplay: !!t.resultDisplay,
          parentCallId: t.parentCallId,
        });
      }),
    [allToolCalls, isLowErrorVerbosity],
  );

  const config = useConfig();
  const {
    constrainHeight,
    activePtyId,
    embeddedShellFocused,
    backgroundShells,
    pendingHistoryItems,
  } = useUIState();
  const isAlternateBuffer = useAlternateBuffer();

  const { borderColor, borderDimColor } = useMemo(
    () =>
      getToolGroupBorderAppearance(
        item,
        activePtyId,
        embeddedShellFocused,
        pendingHistoryItems,
        backgroundShells,
      ),
    [
      item,
      activePtyId,
      embeddedShellFocused,
      pendingHistoryItems,
      backgroundShells,
    ],
  );

  // We HIDE tools that are still in pre-execution states (Confirming, Pending)
  // from the History log. They live in the Global Queue or wait for their turn.
  // Only show tools that are actually running or finished.
  // We explicitly exclude Pending and Confirming to ensure they only
  // appear in the Global Queue until they are approved and start executing.
  const visibleToolCalls = useMemo(
    () =>
      toolCalls.filter((t) => {
        const displayStatus = mapCoreStatusToDisplayStatus(t.status);
        return (
          displayStatus !== ToolCallStatus.Pending &&
          displayStatus !== ToolCallStatus.Confirming
        );
      }),

    [toolCalls],
  );

  const segments = useMemo(() => {
    const segs: ToolSegment[] = [];

    for (const tool of visibleToolCalls) {
      const isCompactToolOutput = isCompactTool(tool, isCompactModeEnabled);

      if (isCompactToolOutput) {
        if (
          segs.length > 0 &&
          segs[segs.length - 1].type === COMPACT_TOOL_VIEW
        ) {
          segs[segs.length - 1].tools.push(tool);
        } else {
          segs.push({ type: COMPACT_TOOL_VIEW, tools: [tool] });
        }
      } else {
        // Standard tools are ALWAYS isolated in their own segment to ensure
        // they render in separate, fully-bordered boxes.
        segs.push({ type: STANDARD_TOOL_VIEW, tools: [tool] });
      }
    }
    return segs;
  }, [visibleToolCalls, isCompactModeEnabled]);

  const staticHeight = useMemo(() => {
    let height = 0;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.type === STANDARD_TOOL_VIEW) {
        // Each standard tool has 3 lines of static overhead in StickyHeader (border/padding, text, separator)
        height += 3 * segment.tools.length;
        // Each standard segment has 1 line for the closing footer border
        height += 1;
      } else {
        // Compact tools take 1 line per tool
        height += segment.tools.length;
      }

      // Spacing between segments (marginTop on all segments except the first)
      if (i > 0) {
        height += 1;
      }
    }

    // if visibleToolCalls is 0, we might still draw a border if borderBottomOverride is true
    if (visibleToolCalls.length === 0 && borderBottomOverride === true) {
      height += 1;
    }
    return height - 2; // adjustment helps align snapshot tests
  }, [segments, borderBottomOverride, visibleToolCalls.length]);

  let countToolCallsWithResults = 0;
  for (const tool of visibleToolCalls) {
    if (tool.resultDisplay !== undefined && tool.resultDisplay !== '') {
      countToolCallsWithResults++;
    }
  }

  const availableTerminalHeightPerToolMessage = availableTerminalHeight
    ? Math.max(
        Math.floor(
          (availableTerminalHeight - staticHeight) /
            Math.max(1, countToolCallsWithResults),
        ),
        1,
      )
    : undefined;

  const contentWidth = terminalWidth - TOOL_MESSAGE_HORIZONTAL_MARGIN;

  /*
   * ToolGroupMessage calculates its own overflow state locally and passes
   * it as a prop to ShowMoreLines. This isolates it from global overflow
   * reports in ASB mode, while allowing it to contribute to the global
   * 'Toast' hint in Standard mode.
   *
   * Because of this prop-based isolation and the explicit mode-checks in
   * AppContainer, we do not need to shadow the OverflowProvider here.
   */
  const hasOverflow = useMemo(() => {
    if (!availableTerminalHeightPerToolMessage) return false;
    return visibleToolCalls.some((tool) => {
      const isShellToolCall = isShellTool(tool.name);
      const isFocused = isThisShellFocused(
        tool.name,
        tool.status,
        tool.ptyId,
        activePtyId,
        embeddedShellFocused,
      );

      let maxLines: number | undefined;

      if (isShellToolCall) {
        maxLines = calculateShellMaxLines({
          status: tool.status,
          isAlternateBuffer,
          isThisShellFocused: isFocused,
          availableTerminalHeight: availableTerminalHeightPerToolMessage,
          constrainHeight,
          isExpandable,
        });
      }

      // Standard tools and Shell tools both eventually use ToolResultDisplay's logic.
      // ToolResultDisplay uses calculateToolContentMaxLines to find the final line budget.
      const contentMaxLines = calculateToolContentMaxLines({
        availableTerminalHeight: availableTerminalHeightPerToolMessage,
        isAlternateBuffer,
        maxLinesLimit: maxLines,
      });

      if (!contentMaxLines) return false;

      if (typeof tool.resultDisplay === 'string') {
        const text = tool.resultDisplay;
        const hasTrailingNewline = text.endsWith('\n');
        const contentText = hasTrailingNewline ? text.slice(0, -1) : text;
        const lineCount = contentText.split('\n').length;
        return lineCount > contentMaxLines;
      }
      if (Array.isArray(tool.resultDisplay)) {
        return tool.resultDisplay.length > contentMaxLines;
      }
      return false;
    });
  }, [
    visibleToolCalls,
    availableTerminalHeightPerToolMessage,
    activePtyId,
    embeddedShellFocused,
    isAlternateBuffer,
    constrainHeight,
    isExpandable,
  ]);

  // If all tools are filtered out (e.g., in-progress AskUser tools, confirming tools),
  // only render if we need to close a border from previous
  // tool groups. borderBottomOverride=true means we must render the closing border;
  // undefined or false means there's nothing to display.
  if (visibleToolCalls.length === 0 && borderBottomOverride !== true) {
    return null;
  }

  const lastSegment =
    segments.length > 0 ? segments[segments.length - 1] : null;

  const content = (
    <Box
      flexDirection="column"
      /*
      This width constraint is highly important and protects us from an Ink rendering bug.
      Since the ToolGroup can typically change rendering states frequently, it can cause
      Ink to render the border of the box incorrectly and span multiple lines and even
      cause tearing.
    */
      width={terminalWidth}
      paddingRight={TOOL_MESSAGE_HORIZONTAL_MARGIN}
      marginBottom={isCompactModeEnabled ? 1 : undefined}
    >
      {segments.map((segment, segmentIndex) => {
        const isFirstSegment = segmentIndex === 0;
        // const isLastSegment = segmentIndex === segments.length - 1;
        const isLastSegment = segment === lastSegment;

        if (isCompactModeEnabled) {
          borderTopOverride = true;
          borderBottomOverride = true;
        } else {
          borderTopOverride = isFirstSegment
            ? (borderTopOverride ?? true)
            : true;
          borderBottomOverride = isLastSegment
            ? (borderBottomOverride ?? true)
            : true;
        }

        // Segment Rendering
        return (
          <Fragment key={`segment-${segmentIndex}`}>
            {segment.type === COMPACT_TOOL_VIEW ? (
              // Rendering compact-view tool output
              <Fragment>
                {segment.tools.map((tool) => {
                  const commonProps = {
                    ...tool,
                    availableTerminalHeight:
                      availableTerminalHeightPerToolMessage,
                    terminalWidth: contentWidth,
                    emphasis: 'medium' as const,
                    isFirst: false,
                    borderColor,
                    borderDimColor,
                    isExpandable,
                  };
                  return (
                    <DenseToolMessage key={tool.callId} {...commonProps} />
                  );
                })}
              </Fragment>
            ) : (
              // Rendering standard view (non-compact) tool output
              <>
                {segment.tools.map((tool /* toolIndex */) => {
                  const isShellToolCall = isShellTool(tool.name);

                  const commonProps = {
                    ...tool,
                    availableTerminalHeight:
                      availableTerminalHeightPerToolMessage,
                    terminalWidth: contentWidth,
                    emphasis: 'medium' as const,
                    isFirst: borderTopOverride === true,
                    borderColor,
                    borderDimColor,
                    isExpandable,
                  };

                  return (
                    <Box
                      key={tool.callId}
                      flexDirection="column"
                      minHeight={1}
                      width={contentWidth}
                    >
                      {isShellToolCall ? (
                        <ShellToolMessage {...commonProps} config={config} />
                      ) : (
                        <ToolMessage {...commonProps} />
                      )}
                      {tool.outputFile && (
                        <Box
                          borderLeft={true}
                          borderRight={true}
                          borderTop={false}
                          borderBottom={false}
                          borderColor={borderColor}
                          borderDimColor={borderDimColor}
                          flexDirection="column"
                          borderStyle="round"
                          paddingLeft={1}
                          paddingRight={1}
                        >
                          <Box>
                            <Text color={theme.text.primary}>
                              Output too long and was saved to:{' '}
                              {tool.outputFile}
                            </Text>
                          </Box>
                        </Box>
                      )}
                    </Box>
                  );
                })}

                <Box // Adds Border bottom when complete
                  height={0}
                  width={contentWidth}
                  borderLeft={true}
                  borderRight={true}
                  borderTop={false}
                  borderBottom={borderBottomOverride === true}
                  borderColor={borderColor}
                  borderDimColor={borderDimColor}
                  borderStyle="round"
                />
              </>
            )}
          </Fragment>
        );
      })}

      {visibleToolCalls.length === 0 &&
        borderBottomOverride === true &&
        !isCompactModeEnabled && (
          <Box // Border bottom while streaming
            height={0}
            width={contentWidth}
            borderLeft={true}
            borderRight={true}
            borderTop={false}
            borderBottom={true}
            borderColor={borderColor}
            borderDimColor={borderDimColor}
            borderStyle="round"
          />
        )}

      {(borderBottomOverride ?? true) &&
        visibleToolCalls.length > 0 &&
        lastSegment?.type === STANDARD_TOOL_VIEW && (
          <ShowMoreLines
            constrainHeight={constrainHeight && !!isExpandable}
            isOverflowing={hasOverflow}
          />
        )}
    </Box>
  );

  return content;
};
