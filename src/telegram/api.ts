import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TEMP_DIR } from "../constants.js";
import type {
  TelegramApiResponse,
  TelegramConfig,
  TelegramGetFileResult,
  TelegramSentMessage,
} from "./types.js";
import { chunkParagraphs, sanitizeFileName } from "../utils.js";

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
      const sent = await this.call<TelegramSentMessage>("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
      lastMessageId = sent.message_id;
    }
    return lastMessageId;
  }
}
