import { stat } from "node:fs/promises";
import { basename } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { MAX_ATTACHMENTS_PER_TURN } from "../constants";
import type { PendingTelegramTurn } from "../telegram/types";

export function createTelegramAttachTool(
  getActiveTurn: () => PendingTelegramTurn | undefined,
  saveActiveTurn: (turn: PendingTelegramTurn) => Promise<void>,
) {
  return defineTool({
    name: "telegram_attach",
    label: "Telegram Attach",
    description:
      "Queue one or more local files to be sent with the next Telegram reply.",
    promptSnippet: "Queue local files to be sent with the next Telegram reply.",
    promptGuidelines: [
      "When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
    ],
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Local file path to attach" }),
        { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN },
      ),
    }),
    async execute(_toolCallId, params) {
      const activeTelegramTurn = getActiveTurn();
      if (!activeTelegramTurn)
        throw new Error(
          "telegram_attach can only be used while replying to an active Telegram turn",
        );
      if (
        activeTelegramTurn.queuedAttachments.length + params.paths.length >
        MAX_ATTACHMENTS_PER_TURN
      )
        throw new Error(
          `Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`,
        );
      for (const inputPath of params.paths) {
        const stats = await stat(inputPath);
        if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`);
      }

      const added = [...params.paths];
      const previousLength = activeTelegramTurn.queuedAttachments.length;
      activeTelegramTurn.queuedAttachments.push(
        ...added.map((path) => ({ path, fileName: basename(path) })),
      );
      try {
        await saveActiveTurn(activeTelegramTurn);
      } catch (error) {
        activeTelegramTurn.queuedAttachments.splice(previousLength);
        throw error;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Queued ${added.length} Telegram attachment(s).`,
          },
        ],
        details: { paths: added },
      };
    },
  });
}
