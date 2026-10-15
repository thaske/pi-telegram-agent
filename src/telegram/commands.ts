import type { CompactionResult, TaskId } from "@earendil-works/pi-durable";

import type { DurableTelegramAgent } from "../pi/durable-agent";
import { log } from "../logger";

import { TelegramApi, TelegramApiError } from "./api";
import { telegramMessageKey } from "./identity";
import { TelegramModelPicker } from "./model-picker";
import type { PendingTelegramTurn, TelegramMessage } from "./types";

type TelegramCommand =
  | "stop"
  | "new"
  | "model"
  | "model-query"
  | "compact"
  | "status"
  | "start";

interface TelegramCommandActions {
  discardPreview: () => void;
  hasPendingTurn: () => boolean;
  getSession: () => Pick<DurableTelegramAgent, "isStreaming" | "model" | "abort" | "startCompaction" | "waitForCompaction" | "getStatus" | "state">;
  newSession: (requestId: string) => Promise<void>;
  onIdle: () => void;
  onReplyQueued: (turn: PendingTelegramTurn) => void;
  onError: (error: unknown) => void;
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
  private readonly background = new Map<string, Promise<void>>();
  private activeHandlers = 0;
  private stopping = false;

  get isBusy(): boolean { return this.activeHandlers > 0 || this.background.size > 0; }

  constructor(
    private readonly api: TelegramApi,
    private readonly modelPicker: TelegramModelPicker,
    private readonly actions: TelegramCommandActions,
  ) {}

  async restore(): Promise<void> {
    for (const { requestId, receipt } of await this.actions.getSession().state.pendingCompactions())
      this.watchCompaction(requestId, receipt.taskId);
  }

  shutdown(): void { this.stopping = true; }

  async handle(messages: TelegramMessage[]): Promise<boolean> {
    this.activeHandlers += 1;
    try {
      const firstMessage = messages[0];
      if (!firstMessage) return true;
      const rawText = this.rawMessageText(messages);
      const lower = rawText.toLowerCase();
      if (await this.handlePendingModelSearch(firstMessage, rawText, lower)) return true;
      const command = this.parseCommand(lower);
      if (!command) return false;
      await this.executeCommand(command, firstMessage, rawText);
      return true;
    } finally {
      this.activeHandlers -= 1;
      if (!this.stopping) this.actions.onIdle();
    }
  }

  async stopCallback(requestId: string): Promise<void> {
    this.activeHandlers += 1;
    try {
      await this.actions.getSession().abort(requestId);
    } finally {
      this.activeHandlers -= 1;
      if (!this.stopping) this.actions.onIdle();
    }
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
    const requestId = telegramMessageKey(message);
    await session.abort(requestId);
    const receipt = await session.state.command(requestId);
    const hadTarget = receipt?.kind === "stop" && (receipt.turnId || receipt.compactionIds.length);
    await this.reply(message, hadTarget ? "Aborted current turn." : "No active turn.");
  }

  private async newChat(message: TelegramMessage): Promise<void> {
    const requestId = telegramMessageKey(message);
    if (!await this.actions.getSession().state.command(requestId)) {
      if (!(await this.ensureIdle(message, "start a new chat"))) return;
      this.actions.discardPreview();
      await this.actions.newSession(requestId);
    }
    await this.reply(message, "New Pi chat started.");
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
    const requestId = telegramMessageKey(message);
    const previous = await session.state.command(requestId);
    if (previous?.kind === "compact" && previous.replyQueued) return;
    if (!previous && !(await this.ensureIdle(message, "compact"))) return;
    const id = await session.startCompaction(requestId, {
      chatId: message.chat.id, replyToMessageId: message.message_id,
    });
    this.watchCompaction(requestId, id);
    await this.reply(message, "Compaction started.");
  }

  private watchCompaction(requestId: string, id: TaskId<CompactionResult>): void {
    if (this.background.has(requestId) || this.stopping) return;
    const work = this.finishCompaction(requestId, id)
      .catch((error: unknown) => { if (!this.stopping) this.actions.onError(error); })
      .finally(() => {
        this.background.delete(requestId);
        if (!this.stopping) this.actions.onIdle();
      });
    this.background.set(requestId, work);
  }

  private async finishCompaction(requestId: string, id: TaskId<CompactionResult>): Promise<void> {
    const session = this.actions.getSession();
    let text = "Compaction completed.";
    try {
      await session.waitForCompaction(id);
    } catch (error) {
      text = `Compaction failed: ${this.errorText(error)}`;
    }
    if (this.stopping) return;
    const turn = await session.state.queueCompactionReply(requestId, text);
    if (turn) this.actions.onReplyQueued(turn);
  }

  private async status(message: TelegramMessage): Promise<void> {
    const session = this.actions.getSession();
    const stats = await session.getStatus();
    const lines = [
      `Model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`,
      `Messages: ${stats.totalMessages}`,
      `Cost: $${stats.cost.toFixed(3)}`,
    ];
    if (stats.contextTokens !== undefined) {
      const percent = stats.contextWindow ? `${(stats.contextTokens / stats.contextWindow * 100).toFixed(1)}%` : "?";
      lines.push(`Context: ${percent}/${stats.contextWindow ?? "?"}`);
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
    if (this.background.size || this.actions.getSession().isStreaming) {
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
    try {
      await this.api.sendTextReply(message.chat.id, message.message_id, text);
    } catch (error) {
      if (!(error instanceof TelegramApiError && error.permanent)) throw error;
      log(`command notification unavailable: ${error.message}`);
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
