import { MAX_RICH_MESSAGE_LENGTH } from "../constants";
import { sendQueuedAttachment } from "./files";
import { TelegramPreviewManager } from "./preview";
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
  if (!response.textDelivered) {
    await sendCompletedText(api, preview, turn, response.text);
    response.textDelivered = true;
    await save();
  }
  while (response.queuedAttachments.length) {
    const attachment = response.queuedAttachments[0];
    if (!attachment) break;
    await sendQueuedAttachment(api, turn, attachment);
    response.queuedAttachments.shift();
    await save();
  }
}

async function sendCompletedText(
  api: TelegramApi,
  preview: TelegramPreviewManager,
  turn: PendingTelegramTurn,
  text: string | undefined,
): Promise<void> {
  if (preview.hasPreview) {
    preview.pendingText = text ?? preview.pendingText ?? "";
  }
  if (text && text.length <= MAX_RICH_MESSAGE_LENGTH) {
    await preview.finalize(turn.chatId);
    return;
  }

  await preview.clear(turn.chatId);
  if (text) await api.sendTextReply(turn.chatId, turn.replyToMessageId, text);
}
