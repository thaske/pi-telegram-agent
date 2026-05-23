import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TEMP_DIR } from "../constants.js";
import type {
  TelegramApiResponse,
  TelegramConfig,
  TelegramGetFileResult,
  TelegramInlineKeyboardMarkup,
  TelegramSentMessage,
} from "./types.js";
import { chunkParagraphs, sanitizeFileName } from "../utils.js";
import { formatTelegramText } from "./format.js";
import { MAX_MESSAGE_LENGTH } from "../constants.js";
import { log } from "../logger.js";

export class TelegramApi {
  constructor(private readonly getConfig: () => TelegramConfig) {}

  async call<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<TResponse> {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      },
    );
    const data = (await response.json()) as TelegramApiResponse<TResponse>;
    if (!data.ok || data.result === undefined)
      throw new Error(data.description || `Telegram API ${method} failed`);
    return data.result;
  }

  async callMultipart<TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: { signal?: AbortSignal },
  ): Promise<TResponse> {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set(fileField, new Blob([await readFile(filePath)]), fileName);
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      { method: "POST", body: form, signal: options?.signal },
    );
    const data = (await response.json()) as TelegramApiResponse<TResponse>;
    if (!data.ok || data.result === undefined)
      throw new Error(data.description || `Telegram API ${method} failed`);
    return data.result;
  }

  async configureCommands(signal?: AbortSignal): Promise<void> {
    await this.call<boolean>(
      "setMyCommands",
      {
        commands: [
          { command: "new", description: "Start a new Pi chat" },
          { command: "status", description: "Show model, usage, and context" },
          { command: "model", description: "Choose the active Pi model" },
          { command: "compact", description: "Compact the current Pi chat" },
          { command: "stop", description: "Abort the active Pi turn" },
          { command: "help", description: "Show Telegram bridge help" },
        ],
      },
      { signal },
    );
  }

  async downloadFile(fileId: string, suggestedName: string): Promise<string> {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    const file = await this.call<TelegramGetFileResult>("getFile", {
      file_id: fileId,
    });
    await mkdir(TEMP_DIR, { recursive: true });
    const targetPath = join(
      TEMP_DIR,
      `${Date.now()}-${sanitizeFileName(suggestedName)}`,
    );
    const response = await fetch(
      `https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
    );
    if (!response.ok)
      throw new Error(`Failed to download Telegram file: ${response.status}`);
    await writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
    return targetPath;
  }

  async sendTextReply(
    chatId: number,
    _replyToMessageId: number,
    text: string,
  ): Promise<number | undefined> {
    let lastMessageId: number | undefined;
    for (const chunk of chunkParagraphs(text)) {
      const sent = await this.sendMessage(chatId, chunk);
      lastMessageId = sent.message_id;
    }
    return lastMessageId;
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<TelegramSentMessage> {
    const formatted = formatTelegramText(text);
    try {
      return await this.call<TelegramSentMessage>("sendMessage", {
        chat_id: chatId,
        text: formatted.text,
        ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (error) {
      const isParseError =
        formatted.parseMode &&
        error instanceof Error &&
        error.message.includes("can't parse entities");
      const isTooLong =
        error instanceof Error &&
        /too long|message is too long/i.test(error.message);
      if (isParseError || isTooLong) {
        log(
          `${isTooLong ? "Message too long" : "HTML parse failed"}, sending plain text: ${error instanceof Error ? error.message : String(error)}`,
        );
        return await this.call<TelegramSentMessage>("sendMessage", {
          chat_id: chatId,
          text: text.slice(0, MAX_MESSAGE_LENGTH),
        });
      }
      throw error;
    }
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    const formatted = formatTelegramText(text);
    try {
      await this.call<unknown>("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: formatted.text,
        ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (error) {
      const isParseError =
        formatted.parseMode &&
        error instanceof Error &&
        error.message.includes("can't parse entities");
      const isTooLong =
        error instanceof Error &&
        /too long|message is too long/i.test(error.message);
      if (isParseError || isTooLong) {
        log(
          `${isTooLong ? "Message too long" : "HTML parse failed"}, editing plain text: ${error instanceof Error ? error.message : String(error)}`,
        );
        await this.call<unknown>("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: text.slice(0, MAX_MESSAGE_LENGTH),
        });
        return;
      }
      throw error;
    }
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
  ): Promise<void> {
    await this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }
}
