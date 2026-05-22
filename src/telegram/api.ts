import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Api, InputFile } from "grammy";

import { TEMP_DIR } from "../constants.js";
import { chunkParagraphs, sanitizeFileName } from "../utils.js";
import type {
  TelegramApiResponse,
  TelegramConfig,
  TelegramUpdate,
} from "./types.js";

export class TelegramApi {
  private client: Api | undefined;
  private clientToken: string | undefined;

  constructor(private readonly getConfig: () => TelegramConfig) {}

  async call<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<TResponse> {
    switch (method) {
      case "deleteWebhook":
        return (await this.getClient().deleteWebhook(
          body,
          this.grammySignal(options?.signal),
        )) as TResponse;
      case "getUpdates":
        return (await this.getClient().getUpdates(
          body,
          this.grammySignal(options?.signal),
        )) as TResponse;
      case "sendChatAction":
        return (await this.getClient().sendChatAction(
          body.chat_id as number | string,
          body.action as "typing",
          {},
          this.grammySignal(options?.signal),
        )) as TResponse;
      case "sendMessage":
        return (await this.getClient().sendMessage(
          body.chat_id as number | string,
          body.text as string,
          this.remaining(body, "chat_id", "text"),
          this.grammySignal(options?.signal),
        )) as TResponse;
      case "editMessageText":
        return (await this.getClient().editMessageText(
          body.chat_id as number | string,
          body.message_id as number,
          body.text as string,
          this.remaining(body, "chat_id", "message_id", "text"),
          this.grammySignal(options?.signal),
        )) as TResponse;
      default:
        return this.callRaw<TResponse>(method, body, options);
    }
  }

  async callMultipart<TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
    options?: { signal?: AbortSignal },
  ): Promise<TResponse> {
    const chatId = fields.chat_id;
    const file = new InputFile(filePath, fileName);
    if (method === "sendPhoto" && fileField === "photo")
      return (await this.getClient().sendPhoto(
        chatId,
        file,
        {},
        this.grammySignal(options?.signal),
      )) as TResponse;
    if (method === "sendDocument" && fileField === "document")
      return (await this.getClient().sendDocument(
        chatId,
        file,
        {},
        this.grammySignal(options?.signal),
      )) as TResponse;
    return this.callRawMultipart<TResponse>(
      method,
      fields,
      fileField,
      filePath,
      fileName,
      options,
    );
  }

  async configureCommands(signal?: AbortSignal): Promise<void> {
    await this.getClient().setMyCommands(
      [
        { command: "new", description: "Start a new Pi chat" },
        { command: "status", description: "Show model, usage, and context" },
        { command: "compact", description: "Compact the current Pi chat" },
        { command: "stop", description: "Abort the active Pi turn" },
        { command: "help", description: "Show Telegram bridge help" },
      ],
      {},
      this.grammySignal(signal),
    );
  }

  async getUpdates(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return (await this.getClient().getUpdates(
      body,
      this.grammySignal(signal),
    )) as TelegramUpdate[];
  }

  async downloadFile(fileId: string, suggestedName: string): Promise<string> {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    const file = await this.getClient().getFile(fileId);
    if (!file.file_path) throw new Error("Telegram file has no download path");
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
      const sent = await this.getClient().sendMessage(chatId, chunk);
      lastMessageId = sent.message_id;
    }
    return lastMessageId;
  }

  private getClient(): Api {
    const { botToken } = this.getConfig();
    if (!botToken) throw new Error("Telegram bot token is not configured");
    if (!this.client || this.clientToken !== botToken) {
      this.client = new Api(botToken);
      this.clientToken = botToken;
    }
    return this.client;
  }

  private remaining(
    body: Record<string, unknown>,
    ...omit: string[]
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(body).filter(([key]) => !omit.includes(key)),
    );
  }

  private grammySignal(signal: AbortSignal | undefined): never {
    return signal as never;
  }

  private async callRaw<TResponse>(
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

  private async callRawMultipart<TResponse>(
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
}
