import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";

import { MAX_ATTACHMENTS_PER_TURN } from "../constants";
import { TelegramState } from "./durable-state";

export function createTelegramAttachTool() {
  return defineTool({
    name: "telegram_attach",
    description: "Queue local files to be sent with the current Telegram reply.",
    replay: "safe",
    parameters: Type.Object({
      paths: Type.Array(
        Type.String({ description: "Local file path to attach, relative to the agent working directory" }),
        { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN },
      ),
    }),
    async execute(params, api, context) {
      const paths = params.paths.map((path) => resolve(api.env?.cwd ?? process.cwd(), path));
      for (const path of paths) {
        const stats = await stat(path);
        if (!stats.isFile()) throw new Error(`Not a file: ${path}`);
      }
      await api.commit(async (tx) => {
        const state = await tx.doc(TelegramState);
        const turn = state.turns[0];
        if (!turn || turn.conversationId !== api.conversationId || turn.completedResponse)
          throw new Error("No active Telegram turn for this conversation");
        // A crash between this commit and the tool result must not queue files twice.
        if (turn.attachmentTaskIds?.includes(api.taskId)) return;
        if (turn.queuedAttachments.length + paths.length > MAX_ATTACHMENTS_PER_TURN)
          throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
        turn.queuedAttachments.push(...paths.map((path) => ({ path, fileName: basename(path) })));
        if (!turn.attachmentTaskIds) turn.attachmentTaskIds = [];
        turn.attachmentTaskIds.push(api.taskId);
      }, context);
      return {
        output: [{ type: "text", text: `Queued ${paths.length} Telegram attachment(s).` }],
        details: { paths },
      };
    },
  });
}
