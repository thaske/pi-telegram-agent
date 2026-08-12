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

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 60;

export class TelegramApi {
  private richMessageSupport: "unknown" | "supported" | "unsupported" =
    "unknown";

  constructor(private readonly getConfig: () => TelegramConfig) {}

  async call<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<TResponse> {
    return this.withRateLimitRetry(method, options?.signal, async () => {
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
      return (await response.json()) as TelegramApiResponse<TResponse>;
    });
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
    const fileContents = await readFile(filePath);
    return this.withRateLimitRetry(method, options?.signal, async () => {
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.set(key, value);
      form.set(fileField, new Blob([fileContents]), fileName);
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/${method}`,
        { method: "POST", body: form, signal: options?.signal },
      );
      return (await response.json()) as TelegramApiResponse<TResponse>;
    });
  }

  /**
   * Telegram answers bursts of edits with 429 and a `retry_after` hint. Honour
   * it a bounded number of times so throttled previews and progress panels are
   * not silently dropped.
   */
  private async withRateLimitRetry<TResponse>(
    method: string,
    signal: AbortSignal | undefined,
    send: () => Promise<TelegramApiResponse<TResponse>>,
  ): Promise<TResponse> {
    for (let attempt = 0; ; attempt++) {
      const data = await send();
      if (data.ok && data.result !== undefined) return data.result;
      const retryAfter = data.parameters?.retry_after;
      if (
        data.error_code !== 429 ||
        retryAfter === undefined ||
        attempt >= MAX_RATE_LIMIT_RETRIES ||
        signal?.aborted
      )
        throw new Error(data.description || `Telegram API ${method} failed`);
      const waitMs = Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000;
      log(`rate limited on ${method}; retrying in ${waitMs}ms`);
      await this.wait(waitMs, signal);
    }
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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
          { command: "goal", description: "Set or manage a long-running Pi goal" },
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
    replyToMessageId: number,
    text: string,
  ): Promise<number | undefined> {
    let lastMessageId: number | undefined;
    const chunks =
      this.richMessageSupport === "unsupported"
        ? chunkParagraphs(text)
        : chunkParagraphs(text, MAX_RICH_MESSAGE_LENGTH);

    let replyTo: number | undefined = replyToMessageId;
    for (const chunk of chunks) {
      if (this.richMessageSupport !== "unsupported") {
        try {
          const sent = await this.sendRichMessage(
            chatId,
            chunk,
            undefined,
            replyTo,
          );
          lastMessageId = sent.message_id;
          replyTo = undefined;
          continue;
        } catch (error) {
          this.handleRichMessageFailure(error, "sending rich text reply");
        }
      }
      for (const legacyChunk of this.chunkLegacyText(chunk)) {
        const sent = await this.sendLegacyMessage(
          chatId,
          legacyChunk,
          undefined,
          replyTo,
        );
        lastMessageId = sent.message_id;
        replyTo = undefined;
      }
    }
    return lastMessageId;
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    replyToMessageId?: number,
  ): Promise<TelegramSentMessage> {
    if (
      this.richMessageSupport !== "unsupported" &&
      text.length <= MAX_RICH_MESSAGE_LENGTH
    ) {
      try {
        return await this.sendRichMessage(
          chatId,
          text,
          replyMarkup,
          replyToMessageId,
        );
      } catch (error) {
        this.handleRichMessageFailure(error, "sending legacy message");
      }
    }
    const legacyChunks = this.chunkLegacyText(text);
    let sent: TelegramSentMessage | undefined;
    for (let i = 0; i < legacyChunks.length; i++)
      sent = await this.sendLegacyMessage(
        chatId,
        legacyChunks[i] ?? "",
        i === legacyChunks.length - 1 ? replyMarkup : undefined,
        i === 0 ? replyToMessageId : undefined,
      );
    return sent!;
  }

  async sendRichMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    replyToMessageId?: number,
  ): Promise<TelegramSentMessage> {
    const sent = await this.call<TelegramSentMessage>("sendRichMessage", {
      chat_id: chatId,
      rich_message: this.toInputRichMessage(text),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...this.replyParameters(replyToMessageId),
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
    const legacyChunks = this.chunkLegacyText(text);
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
  }

  private async sendLegacyMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
    replyToMessageId?: number,
  ): Promise<TelegramSentMessage> {
    const formatted = formatTelegramText(text);
    try {
      return await this.call<TelegramSentMessage>("sendMessage", {
        chat_id: chatId,
        text: formatted.text,
        ...(formatted.parseMode ? { parse_mode: formatted.parseMode } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        ...this.replyParameters(replyToMessageId),
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
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          ...this.replyParameters(replyToMessageId),
        });
      }
      throw error;
    }
  }

  private chunkLegacyText(text: string): string[] {
    const chunks: string[] = [];
    for (const rawChunk of chunkParagraphs(text)) {
      let remaining = rawChunk;
      while (remaining) {
        if (formatTelegramText(remaining).text.length <= MAX_MESSAGE_LENGTH) {
          chunks.push(remaining);
          break;
        }
        let low = 1;
        let high = Math.min(remaining.length, MAX_MESSAGE_LENGTH);
        let splitAt = 0;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (
            formatTelegramText(remaining.slice(0, middle)).text.length <=
            MAX_MESSAGE_LENGTH
          ) {
            splitAt = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
        if (splitAt === 0) splitAt = 1;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
      }
    }
    return chunks.length ? chunks : [""];
  }

  private replyParameters(replyToMessageId?: number): Record<string, unknown> {
    return replyToMessageId === undefined
      ? {}
      : { reply_parameters: { message_id: replyToMessageId } };
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
          text,
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

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call<boolean>("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
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
