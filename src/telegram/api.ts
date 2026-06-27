import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_MESSAGE_LENGTH,
  MAX_RICH_MESSAGE_LENGTH,
  TEMP_DIR,
} from "../constants";
import { log } from "../logger";
import { chunkParagraphs, sanitizeFileName } from "../utils";
import { formatTelegramText } from "./format";
import { toTelegramRichMarkdown } from "./rich-markdown";
import type {
  TelegramApiResponse,
  TelegramConfig,
  TelegramGetFileResult,
  TelegramInlineKeyboardMarkup,
  TelegramInputRichMessage,
  TelegramSentMessage,
} from "./types";

export class TelegramApi {
  private richMessageSupport: "unknown" | "supported" | "unsupported" =
    "unknown";

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
    const chunks =
      this.richMessageSupport === "unsupported"
        ? chunkParagraphs(text)
        : chunkParagraphs(text, MAX_RICH_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      if (this.richMessageSupport !== "unsupported") {
        try {
          const sent = await this.sendRichMessage(chatId, chunk);
          lastMessageId = sent.message_id;
          continue;
        } catch (error) {
          this.handleRichMessageFailure(error, "sending rich text reply");
        }
      }
      for (const legacyChunk of chunkParagraphs(chunk)) {
        const sent = await this.sendLegacyMessage(chatId, legacyChunk);
        lastMessageId = sent.message_id;
      }
    }
    return lastMessageId;
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<TelegramSentMessage> {
    if (
      this.richMessageSupport !== "unsupported" &&
      text.length <= MAX_RICH_MESSAGE_LENGTH
    ) {
      try {
        return await this.sendRichMessage(chatId, text, replyMarkup);
      } catch (error) {
        this.handleRichMessageFailure(error, "sending legacy message");
      }
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      let sent: TelegramSentMessage | undefined;
      const legacyChunks = chunkParagraphs(text);
      for (let i = 0; i < legacyChunks.length; i++)
        sent = await this.sendLegacyMessage(
          chatId,
          legacyChunks[i] ?? "",
          i === legacyChunks.length - 1 ? replyMarkup : undefined,
        );
      return sent!;
    }
    return await this.sendLegacyMessage(chatId, text, replyMarkup);
  }

  async sendRichMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<TelegramSentMessage> {
    const sent = await this.call<TelegramSentMessage>("sendRichMessage", {
      chat_id: chatId,
      rich_message: this.toInputRichMessage(text),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    this.richMessageSupport = "supported";
    return sent;
  }

  async sendRichMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
  ): Promise<void> {
    await this.call<boolean>("sendRichMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      rich_message: this.toInputRichMessage(text),
    });
    this.richMessageSupport = "supported";
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    if (
      this.richMessageSupport !== "unsupported" &&
      text.length <= MAX_RICH_MESSAGE_LENGTH
    ) {
      try {
        await this.call<unknown>("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          rich_message: this.toInputRichMessage(text),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        this.richMessageSupport = "supported";
        return;
      } catch (error) {
        this.handleRichMessageFailure(error, "editing legacy message");
      }
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
      const legacyChunks = chunkParagraphs(text);
      await this.editLegacyMessageText(
        chatId,
        messageId,
        legacyChunks[0] ?? "",
        legacyChunks.length === 1 ? replyMarkup : undefined,
      );
      for (let i = 1; i < legacyChunks.length; i++)
        await this.sendLegacyMessage(
          chatId,
          legacyChunks[i] ?? "",
          i === legacyChunks.length - 1 ? replyMarkup : undefined,
        );
      return;
    }
    await this.editLegacyMessageText(chatId, messageId, text, replyMarkup);
  }

  private async sendLegacyMessage(
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
      const isParseError = this.isLegacyHtmlParseError(error, formatted);
      const isTooLong = this.isTooLongError(error);
      if (isParseError || isTooLong) {
        log(
          `${isTooLong ? "Message too long" : "HTML parse failed"}, sending plain text: ${this.formatError(error)}`,
        );
        return await this.call<TelegramSentMessage>("sendMessage", {
          chat_id: chatId,
          text: text.slice(0, MAX_MESSAGE_LENGTH),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
      }
      throw error;
    }
  }

  private async editLegacyMessageText(
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
      const isParseError = this.isLegacyHtmlParseError(error, formatted);
      const isTooLong = this.isTooLongError(error);
      if (isParseError || isTooLong) {
        log(
          `${isTooLong ? "Message too long" : "HTML parse failed"}, editing plain text: ${this.formatError(error)}`,
        );
        await this.call<unknown>("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text: text.slice(0, MAX_MESSAGE_LENGTH),
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        return;
      }
      throw error;
    }
  }

  private toInputRichMessage(text: string): TelegramInputRichMessage {
    return { markdown: toTelegramRichMarkdown(text) };
  }

  private handleRichMessageFailure(
    error: unknown,
    fallbackAction: string,
  ): void {
    const unsupported = this.isRichMessageUnsupportedError(error);
    if (unsupported) this.richMessageSupport = "unsupported";
    log(
      `${unsupported ? "Rich messages unsupported" : "Rich message failed"}, ${fallbackAction}: ${this.formatError(error)}`,
    );
  }

  private isRichMessageUnsupportedError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (/method not found|unsupported|can't find method/i.test(error.message) ||
        /^not found$/i.test(error.message.trim()))
    );
  }

  private isLegacyHtmlParseError(
    error: unknown,
    formatted: ReturnType<typeof formatTelegramText>,
  ): boolean {
    return (
      !!formatted.parseMode &&
      error instanceof Error &&
      error.message.includes("can't parse entities")
    );
  }

  private isTooLongError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /too long|message is too long/i.test(error.message)
    );
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
