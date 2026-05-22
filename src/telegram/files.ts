import { readFile } from "node:fs/promises";

import { TELEGRAM_PREFIX } from "../constants.js";
import { TelegramApi } from "./api.js";
import type {
  DownloadedTelegramFile,
  PendingTelegramTurn,
  TelegramFileInfo,
  TelegramMessage,
  TelegramSentMessage,
} from "./types.js";
import { guessExtensionFromMime, guessMediaType } from "../utils.js";

export async function sendQueuedAttachments(
  api: TelegramApi,
  turn: PendingTelegramTurn,
): Promise<void> {
  for (const attachment of turn.queuedAttachments) {
    try {
      const mediaType = guessMediaType(attachment.path);
      await api.callMultipart<TelegramSentMessage>(
        mediaType ? "sendPhoto" : "sendDocument",
        { chat_id: String(turn.chatId) },
        mediaType ? "photo" : "document",
        attachment.path,
        attachment.fileName,
      );
    } catch (error) {
      await api.sendTextReply(
        turn.chatId,
        turn.replyToMessageId,
        `Failed to send attachment ${attachment.fileName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function collectTelegramFileInfos(
  messages: TelegramMessage[],
): TelegramFileInfo[] {
  const files: TelegramFileInfo[] = [];
  for (const message of messages) {
    const photo = message.photo?.at(-1);
    if (photo)
      files.push({
        file_id: photo.file_id,
        fileName: `photo-${message.message_id}.jpg`,
        mimeType: "image/jpeg",
        isImage: true,
      });
    if (message.document)
      files.push({
        file_id: message.document.file_id,
        fileName:
          message.document.file_name || `document-${message.message_id}`,
        mimeType: message.document.mime_type,
        isImage: !!message.document.mime_type?.startsWith("image/"),
      });
    if (message.video)
      files.push({
        file_id: message.video.file_id,
        fileName:
          message.video.file_name ||
          `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`,
        mimeType: message.video.mime_type,
        isImage: false,
      });
    if (message.audio)
      files.push({
        file_id: message.audio.file_id,
        fileName:
          message.audio.file_name ||
          `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`,
        mimeType: message.audio.mime_type,
        isImage: false,
      });
    if (message.voice)
      files.push({
        file_id: message.voice.file_id,
        fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
        mimeType: message.voice.mime_type,
        isImage: false,
      });
    if (message.animation)
      files.push({
        file_id: message.animation.file_id,
        fileName:
          message.animation.file_name ||
          `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`,
        mimeType: message.animation.mime_type,
        isImage: false,
      });
    if (message.sticker)
      files.push({
        file_id: message.sticker.file_id,
        fileName: `sticker-${message.message_id}.webp`,
        mimeType: "image/webp",
        isImage: true,
      });
  }
  return files;
}

export async function buildTelegramFiles(
  api: TelegramApi,
  messages: TelegramMessage[],
): Promise<DownloadedTelegramFile[]> {
  const downloaded: DownloadedTelegramFile[] = [];
  for (const file of collectTelegramFileInfos(messages))
    downloaded.push({
      path: await api.downloadFile(file.file_id, file.fileName),
      fileName: file.fileName,
      isImage: file.isImage,
      mimeType: file.mimeType,
    });
  return downloaded;
}

export async function createTelegramTurn(
  api: TelegramApi,
  messages: TelegramMessage[],
  historyTurns: PendingTelegramTurn[] = [],
): Promise<PendingTelegramTurn> {
  const firstMessage = messages[0];
  if (!firstMessage) throw new Error("Missing Telegram message");
  const rawText = messages
    .map((m) => (m.text || m.caption || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const files = await buildTelegramFiles(api, messages);
  let prompt = `${TELEGRAM_PREFIX}`;
  if (historyTurns.length > 0) {
    prompt +=
      "\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:";
    for (const [index, turn] of historyTurns.entries())
      prompt += `\n\n${index + 1}. ${turn.historyText}`;
    prompt += "\n\nCurrent Telegram message:";
  }
  if (rawText)
    prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
  if (files.length)
    prompt +=
      "\n\nTelegram attachments were saved locally:" +
      files.map((f) => `\n- ${f.path}`).join("");
  const content: PendingTelegramTurn["content"] = [
    { type: "text", text: prompt },
  ];
  for (const file of files) {
    if (!file.isImage) continue;
    const mimeType = file.mimeType || guessMediaType(file.path);
    if (!mimeType) continue;
    content.push({
      type: "image",
      mimeType,
      data: (await readFile(file.path)).toString("base64"),
    });
  }
  const historyText =
    rawText ||
    "(no text)" +
      (files.length
        ? `\nAttachments:${files.map((f) => `\n- ${f.path}`).join("")}`
        : "");
  return {
    chatId: firstMessage.chat.id,
    replyToMessageId: firstMessage.message_id,
    queuedAttachments: [],
    content,
    historyText,
  };
}
