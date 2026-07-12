import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { TelegramApi } from "./api";
import { TelegramModelPicker } from "./model-picker";
import type { TelegramMessage } from "./types";

type TelegramCommand =
  | "stop"
  | "new"
  | "model"
  | "model-query"
  | "compact"
  | "status"
  | "start";

interface TelegramCommandActions {
  bindSession: () => Promise<void>;
  clearQueuedTurns: () => void;
  discardPreview: () => void;
  getQueueLength: () => number;
  hasPendingTurn: () => boolean;
  getSession: () => AgentSession;
  newSession: () => Promise<{ cancelled: boolean }>;
  preserveQueuedTurnsAsHistory: () => void;
}

const EXACT_COMMANDS = new Map<string, TelegramCommand>([
  ["stop", "stop"],
  ["/stop", "stop"],
  ["new", "new"],
  ["/new", "new"],
  ["/reset", "new"],
  ["model", "model"],
  ["/model", "model"],
  ["/compact", "compact"],
  ["/status", "status"],
  ["/start", "start"],
]);

const MODEL_QUERY_PREFIXES = ["/model ", "model "];

export class TelegramCommandHandler {
  constructor(
    private readonly api: TelegramApi,
    private readonly modelPicker: TelegramModelPicker,
    private readonly actions: TelegramCommandActions,
  ) {}

  async handle(messages: TelegramMessage[]): Promise<boolean> {
    const firstMessage = messages[0];
    if (!firstMessage) return true;

    const rawText = this.rawMessageText(messages);
    const lower = rawText.toLowerCase();
    if (await this.handlePendingModelSearch(firstMessage, rawText, lower)) {
      return true;
    }

    const command = this.parseCommand(lower);
    if (!command) return false;

    await this.executeCommand(command, firstMessage, rawText);
    return true;
  }

  private rawMessageText(messages: TelegramMessage[]): string {
    return (
      messages.map((message) => (message.text || message.caption || "").trim())
        .find(Boolean) || ""
    );
  }

  private parseCommand(lowerText: string): TelegramCommand | undefined {
    return (
      EXACT_COMMANDS.get(lowerText) ??
      (MODEL_QUERY_PREFIXES.some((prefix) => lowerText.startsWith(prefix))
        ? "model-query"
        : undefined)
    );
  }

  private async executeCommand(
    command: TelegramCommand,
    message: TelegramMessage,
    rawText: string,
  ): Promise<void> {
    switch (command) {
      case "stop":
        await this.stop(message);
        return;
      case "new":
        await this.newChat(message);
        return;
      case "model":
        await this.showModelPicker(message);
        return;
      case "model-query":
        await this.selectModelByQuery(message, rawText);
        return;
      case "compact":
        await this.compact(message);
        return;
      case "status":
        await this.status(message);
        return;
      case "start":
        await this.start(message);
    }
  }

  private async handlePendingModelSearch(
    message: TelegramMessage,
    rawText: string,
    lowerText: string,
  ): Promise<boolean> {
    if (
      !this.modelPicker.hasPendingSearch(message.chat.id) ||
      lowerText.startsWith("/")
    ) {
      return false;
    }

    this.modelPicker.consumePendingSearch(message.chat.id);
    if (!(await this.ensureIdle(message, "change models"))) return true;
    await this.modelPicker.showFiltered(message.chat.id, message.message_id, rawText);
    return true;
  }

  private async stop(message: TelegramMessage): Promise<void> {
    const session = this.actions.getSession();
    if (!session.isStreaming) {
      await this.reply(message, "No active turn.");
      return;
    }

    if (this.actions.getQueueLength()) this.actions.preserveQueuedTurnsAsHistory();
    await session.abort();
    await this.reply(message, "Aborted current turn.");
  }

  private async newChat(message: TelegramMessage): Promise<void> {
    if (!(await this.ensureIdle(message, "start a new chat"))) return;

    await this.reply(message, "Starting a new Pi chat...");
    this.actions.clearQueuedTurns();
    this.actions.discardPreview();
    const result = await this.actions.newSession();
    if (!result.cancelled) await this.reply(message, "New Pi chat started.");
    await this.actions.bindSession();
  }

  private async showModelPicker(message: TelegramMessage): Promise<void> {
    if (!(await this.ensureIdle(message, "change models"))) return;
    await this.modelPicker.show(message.chat.id, message.message_id);
  }

  private async selectModelByQuery(
    message: TelegramMessage,
    rawText: string,
  ): Promise<void> {
    if (!(await this.ensureIdle(message, "change models"))) return;

    const query = rawText.replace(/^\/?model\s+/i, "").trim();
    await this.modelPicker.selectByQuery(message.chat.id, message.message_id, query);
  }

  private async compact(message: TelegramMessage): Promise<void> {
    const session = this.actions.getSession();
    if (!(await this.ensureIdle(message, "compact"))) return;

    await this.reply(message, "Compaction started.");
    try {
      await session.compact();
      await this.reply(message, "Compaction completed.");
    } catch (error) {
      await this.reply(message, `Compaction failed: ${this.errorText(error)}`);
    }
  }

  private async status(message: TelegramMessage): Promise<void> {
    const session = this.actions.getSession();
    const stats = session.getSessionStats();
    const usage = session.getContextUsage();
    const lines = [
      `Model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`,
      `Messages: ${stats.totalMessages}`,
      `Cost: $${stats.cost.toFixed(3)}`,
    ];
    if (usage) {
      lines.push(
        `Context: ${usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?"}/${usage.contextWindow ?? session.model?.contextWindow ?? "?"}`,
      );
    }
    await this.reply(message, lines.join("\n"));
  }

  private async start(message: TelegramMessage): Promise<void> {
    await this.reply(
      message,
      "Send me a message and I will forward it to Pi. Commands: /new, /status, /model, /compact, /stop.",
    );
  }

  private async ensureIdle(
    message: TelegramMessage,
    action: string,
  ): Promise<boolean> {
    if (this.actions.getSession().isStreaming) {
      await this.reply(
        message,
        `Cannot ${action} while pi is busy. Send /stop first.`,
      );
      return false;
    }
    if (this.actions.hasPendingTurn()) {
      await this.reply(
        message,
        `Cannot ${action} while the previous response is still being delivered. Try again shortly.`,
      );
      return false;
    }
    return true;
  }

  private async reply(message: TelegramMessage, text: string): Promise<void> {
    await this.api.sendTextReply(message.chat.id, message.message_id, text);
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
