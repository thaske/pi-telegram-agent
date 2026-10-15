import { sendQueuedAttachment } from "./files";
import type { TelegramPreviewManager } from "./preview";
import type { TelegramApi } from "./api";
import type { PendingTelegramTurn } from "./types";

export async function deliverPendingTelegramResponse(
  api: TelegramApi,
  preview: TelegramPreviewManager,
  turn: PendingTelegramTurn,
  save: () => Promise<void>,
): Promise<void> {
  const response = turn.completedResponse;
  if (!response) return;
  await preview.clear(turn.chatId);
  if (!response.textDelivered) {
    if (!response.textChunks) {
      response.textChunks = response.text ? api.planText(response.text) : [];
      response.sentTextChunks = 0;
      await save();
    }
    while ((response.sentTextChunks ?? 0) < response.textChunks.length) {
      const index = response.sentTextChunks ?? 0;
      const chunk = response.textChunks[index];
      try {
        await api.sendTextChunk(turn.chatId, chunk, index === 0 ? turn.replyToMessageId : undefined);
      } catch (error) {
        const fallback = api.fallbackChunks(chunk, error);
        if (!fallback) throw error;
        // Commit the replacement plan before sending any of its messages.
        response.textChunks.splice(index, 1, ...fallback);
        await save();
        continue;
      }
      response.sentTextChunks = index + 1;
      await save();
    }
    response.textDelivered = true;
    await save();
  }
  while (response.queuedAttachments.length) {
    const attachment = response.queuedAttachments[0];
    await sendQueuedAttachment(api, turn, attachment);
    response.queuedAttachments.shift();
    await save();
  }
}
