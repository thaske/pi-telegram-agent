import { setTimeout as delay } from "node:timers/promises";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";

import { log } from "./logger";
import { DurableTelegramAgent, type TelegramTurnResult } from "./pi/durable-agent";
import { applyMessageChanges, getMessageText } from "./pi/session-messages";
import { TelegramApi, TelegramApiError } from "./telegram/api";
import { telegramTurnId } from "./telegram/identity";
import { TelegramCommandHandler } from "./telegram/commands";
import { createTelegramTurn } from "./telegram/files";
import { TelegramMediaGroupBuffer } from "./telegram/media-groups";
import { TelegramModelPicker } from "./telegram/model-picker";
import { TelegramPreviewManager } from "./telegram/preview";
import { TelegramProgressManager } from "./telegram/progress";
import { deliverPendingTelegramResponse } from "./telegram/response-delivery";
import type {
  PendingTelegramTurn,
  TelegramCallbackQuery,
  TelegramConfig,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram/types";

const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_RETRY_DELAY_MS = 5000;

export class TelegramBridge {
  readonly api: TelegramApi;
  readonly preview: TelegramPreviewManager;
  readonly progress: TelegramProgressManager;
  private readonly unsubscribe: () => void;
  private queuedTelegramTurns: PendingTelegramTurn[] = [];
  private activeTelegramTurn: PendingTelegramTurn | undefined;
  private partialMessage: AssistantMessage | undefined;
  private deliveryInFlight: Promise<void> | undefined;
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private deliveryAttempts = 0;
  private stopping = false;
  private pollingSignal: AbortSignal | undefined;
  private readonly controller = new AbortController();
  private readonly commandHandler: TelegramCommandHandler;
  private readonly mediaGroups: TelegramMediaGroupBuffer;
  private readonly modelPicker: TelegramModelPicker;

  constructor(
    private readonly config: TelegramConfig,
    private readonly saveConfig: (config: TelegramConfig) => Promise<void>,
    private readonly agent: DurableTelegramAgent,
    private readonly onFatalError: (error: unknown) => void = () => undefined,
  ) {
    this.api = new TelegramApi(() => this.config);
    this.preview = new TelegramPreviewManager(this.api, async (_chatId, messageId) => {
      const turn = this.activeTelegramTurn;
      if (!turn) throw new Error("No active Telegram preview owner");
      turn.previewMessageIds ??= [];
      if (!turn.previewMessageIds.includes(messageId)) turn.previewMessageIds.push(messageId);
      await this.agent.state.recordPreview(turn.id, messageId);
    });
    this.progress = new TelegramProgressManager(this.api);
    this.mediaGroups = new TelegramMediaGroupBuffer((messages) => this.dispatchAuthorizedTelegramMessages(messages));
    this.modelPicker = new TelegramModelPicker(this.api, () => this.agent);
    this.commandHandler = new TelegramCommandHandler(this.api, this.modelPicker, {
      discardPreview: () => this.preview.discard(),
      hasPendingTurn: () => this.activeTelegramTurn !== undefined || this.queuedTelegramTurns.length > 0 || this.mediaGroups.hasPending,
      getSession: () => this.agent,
      newSession: (requestId) => this.agent.newSession(requestId),
      onIdle: () => this.startNextTurnSafely(),
      onReplyQueued: (turn) => { this.queuedTelegramTurns.push(turn); },
      onError: (error) => this.onFatalError(error),
    });
    this.unsubscribe = agent.subscribe((event) => this.onAgentEvent(event));
  }

  async pollLoop(signal: AbortSignal): Promise<void> {
    signal = AbortSignal.any([signal, this.controller.signal]);
    this.pollingSignal = signal;
    if (!this.config.botToken) throw new Error("Telegram bot token is not configured");
    await this.api.call("deleteWebhook", { drop_pending_updates: false }, { signal }).catch(() => undefined);
    await this.api.configureCommands(signal);
    if (this.config.lastUpdateId === undefined) {
      const updates = await this.api.call<TelegramUpdate[]>(
        "getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal },
      );
      const last = updates.at(-1);
      if (last) {
        this.config.lastUpdateId = last.update_id;
        await this.saveConfig(this.config);
      }
    }
    log("telegram polling started");
    while (!signal.aborted) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>("getUpdates", {
          offset: this.config.lastUpdateId !== undefined ? this.config.lastUpdateId + 1 : undefined,
          limit: 10,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        }, { signal });
        for (const update of updates) {
          if (signal.aborted) return;
          // Never acknowledge an update whose durable admission failed.
          await this.handleUpdate(update);
          this.config.lastUpdateId = update.update_id;
          await this.saveConfig(this.config);
        }
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        log(`polling error: ${this.errorText(error)}`);
        await delay(3000, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  async restorePendingTurns(): Promise<boolean> {
    this.queuedTelegramTurns = await this.agent.state.pendingTurns();
    await this.commandHandler.restore();
    for (const message of await this.agent.state.bufferedMedia()) this.mediaGroups.handle(message);
    const restored = this.queuedTelegramTurns.length > 0;
    await this.startNextTurnIfIdle();
    return restored;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    this.commandHandler.shutdown();
    this.cancelDeliveryRetry();
    this.preview.stopTypingLoop();
    this.progress.discard();
    this.unsubscribe();
    await this.mediaGroups.discard();
    await this.deliveryInFlight;
    if (this.activeTelegramTurn)
      await this.preview.clear(this.activeTelegramTurn.chatId).catch(() => undefined);
  }

  private async startNextTurnIfIdle(): Promise<void> {
    if (this.stopping || this.commandHandler.isBusy || this.activeTelegramTurn || this.deliveryInFlight || this.queuedTelegramTurns.length === 0) return;
    const turn = this.queuedTelegramTurns.shift();
    if (!turn) return;
    this.activeTelegramTurn = turn;
    this.preview.restoreMessages(turn.chatId, turn.previewMessageIds ?? []);
    if (turn.completedResponse) {
      await this.deliverCompletedTurn(turn);
      return;
    }
    this.partialMessage = undefined;
    this.preview.reset(turn.replyToMessageId);
    this.progress.start(turn.chatId, turn.replyToMessageId);
    this.preview.startTypingLoop(turn.chatId);
    void this.agent.runTurn(turn)
      .then((result) => this.completeRun(turn, result))
      .catch((error) => {
        // Harness failures are fatal and handled by main; the durable input remains
        // pending for the next process, rather than being replaced with an error reply.
        log(`durable turn ${turn.id} stopped: ${this.errorText(error)}`);
        if (!this.stopping) this.onFatalError(error);
      });
  }

  private async dispatchAuthorizedTelegramMessages(messages: TelegramMessage[]): Promise<void> {
    if (this.stopping) return;
    const unprocessed = await this.agent.state.unprocessedMessages(messages);
    const ids = new Set(unprocessed.map((message) => message.message_id));
    const received = messages.filter((message) => !ids.has(message.message_id));
    if (received.length) await this.agent.state.completeMedia(received);
    messages = unprocessed;
    if (!messages.length) return;
    if (await this.commandHandler.handle(messages)) {
      await this.agent.state.completeMedia(messages);
      return;
    }
    let turn: PendingTelegramTurn;
    try {
      turn = await createTelegramTurn(this.api, messages, this.pollingSignal ?? this.controller.signal);
    } catch (error) {
      if (!(error instanceof TelegramApiError && error.permanent)) throw error;
      // Reject this input durably rather than poisoning the polling offset.
      const first = messages[0];
      turn = {
        id: telegramTurnId(messages), chatId: first.chat.id, replyToMessageId: first.message_id,
        content: [], historyText: "(Telegram attachment unavailable)", queuedAttachments: [],
        completedResponse: {
          text: `Could not read this Telegram attachment: ${error.message.slice(0, 500)}`,
          textDelivered: false, queuedAttachments: [],
        },
      };
    }
    if (this.stopping || !await this.agent.enqueueTurn(turn, messages)) return;
    this.queuedTelegramTurns.push(turn);
    await this.startNextTurnIfIdle();
  }

  private async handleAuthorizedTelegramMessage(message: TelegramMessage): Promise<void> {
    if (message.media_group_id) {
      if (await this.agent.state.bufferMedia(message)) this.mediaGroups.handle(message);
      return;
    }
    await this.dispatchAuthorizedTelegramMessages([message]);
  }

  private async handleAuthorizedCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!query.message) return;
    if (query.data === "turn:stop") {
      const requestId = `telegram:callback:${query.id}`;
      await this.commandHandler.stopCallback(requestId);
      const receipt = await this.agent.state.command(requestId);
      const hadTarget = receipt?.kind === "stop" && (receipt.turnId || receipt.compactionIds.length);
      await this.api.answerCallbackQuery(query.id, hadTarget ? "Aborting current turn…" : "No active turn.");
      return;
    }
    await this.modelPicker.handleCallbackQuery(query);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const query = update.callback_query;
    if (query) {
      if (query.from.is_bot) return;
      if (this.config.allowedUserId === undefined) {
        this.config.allowedUserId = query.from.id;
        await this.saveConfig(this.config);
      }
      if (query.from.id !== this.config.allowedUserId) {
        await this.api.answerCallbackQuery(query.id, "This bot is not authorized for your account.")
          .catch((error: unknown) => log(`authorization notification failed: ${this.errorText(error)}`));
        return;
      }
      try {
        await this.handleAuthorizedCallbackQuery(query);
      } catch (error) {
        if (!(error instanceof TelegramApiError && error.permanent)) throw error;
        log(`callback unavailable: ${error.message}`);
      }
      return;
    }
    // Edits must not replay an already-admitted input.
    const message = update.message;
    if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
    if (this.config.allowedUserId === undefined) {
      this.config.allowedUserId = message.from.id;
      await this.saveConfig(this.config);
      await this.api.sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.")
        .catch((error: unknown) => log(`pairing notification failed: ${this.errorText(error)}`));
    }
    if (message.from.id !== this.config.allowedUserId) {
      await this.api.sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.")
        .catch((error: unknown) => log(`authorization notification failed: ${this.errorText(error)}`));
      return;
    }
    await this.handleAuthorizedTelegramMessage(message);
  }

  private onAgentEvent(event: AgentEvent): void {
    if (this.stopping || !this.activeTelegramTurn || this.activeTelegramTurn.completedResponse) return;
    this.handleMessageEvent(event);
    this.handleToolEvent(event);
    switch (event.type) {
      case "compaction_start":
        this.progress.setStatus("compaction", "Preparing more context…");
        break;
      case "compaction_end":
        this.progress.setStatus("compaction", event.error ? `Context preparation failed · ${event.error}` : undefined);
        break;
      case "auto_retry_start":
        this.progress.setStatus("retry", `Retrying after an error · attempt ${event.attempt}`);
        break;
      case "auto_retry_end":
        this.progress.setStatus("retry", undefined);
    }
  }

  private handleMessageEvent(event: AgentEvent): void {
    const turn = this.activeTelegramTurn!;
    if (event.type === "snapshot") {
      this.partialMessage = event.generation?.message ? structuredClone(event.generation.message) : undefined;
      if (event.generation?.retry) this.progress.setStatus("retry", "Retrying after an error…");
    } else if (event.type === "message_start" && event.message.role === "assistant") {
      this.partialMessage = structuredClone(event.message);
      this.progress.markAssistantStreaming();
      void this.preview.clear(turn.chatId)
        .catch((error: unknown) => log(`preview cleanup failed: ${this.errorText(error)}`));
      this.preview.reset(turn.replyToMessageId);
    } else if (event.type === "message_update") {
      this.handleMessageUpdate(event);
    } else if (event.type === "message_end") {
      const message = event.entry.model?.find((item) => item.role === "assistant");
      if (message) this.partialMessage = structuredClone(message);
      this.progress.markThinking(false);
    } else return;
    if (this.partialMessage) {
      this.preview.pendingText = getMessageText(this.partialMessage);
      this.preview.scheduleFlush(turn.chatId);
    }
  }

  private handleMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
    this.partialMessage = applyMessageChanges(this.partialMessage, event.changes);
    if (event.changes.some((change) => change.type.startsWith("thinking_"))) this.progress.markThinking(true);
    if (event.changes.some((change) => change.type.startsWith("text_"))) {
      this.progress.markThinking(false);
      this.progress.markAssistantStreaming();
    }
  }

  private handleToolEvent(event: AgentEvent): void {
    switch (event.type) {
      case "snapshot":
        for (const tool of [...event.tools, ...event.nestedTools]) {
          if (tool.status !== "done") this.progress.toolStart(tool.callId, tool.name, "arguments" in tool ? tool.arguments : {});
        }
        return;
      case "tool_execution_start":
        this.progress.toolStart(event.toolCallId, event.toolName, event.args);
        return;
      case "tool_execution_end": {
        const result = event.entry?.model?.find((message) => message.role === "toolResult");
        this.progress.toolEnd(event.toolCallId, event.toolName, result ?? event.result, result?.isError ?? event.result?.isError ?? true);
      }
    }
  }

  private async completeRun(turn: PendingTelegramTurn, result: TelegramTurnResult): Promise<void> {
    if (this.stopping || this.activeTelegramTurn !== turn) return;
    this.preview.stopTypingLoop();
    if (result.error) this.progress.fail(result.error);
    else this.progress.complete();
    if (result.aborted) await this.preview.clear(turn.chatId);
    turn.queuedAttachments = result.queuedAttachments;
    turn.completedResponse = {
      text: result.error ?? result.text,
      textDelivered: !!result.aborted,
      queuedAttachments: result.queuedAttachments,
    };
    await this.deliverCompletedTurn(turn);
  }

  private deliverCompletedTurn(turn: PendingTelegramTurn): Promise<void> {
    if (this.stopping || !turn.completedResponse || this.activeTelegramTurn !== turn) return Promise.resolve();
    if (this.deliveryInFlight) return this.deliveryInFlight;
    const delivery = this.runResponseDelivery(turn).finally(() => {
      if (this.deliveryInFlight === delivery) this.deliveryInFlight = undefined;
      this.startNextTurnSafely();
    });
    this.deliveryInFlight = delivery;
    return delivery;
  }

  private async runResponseDelivery(turn: PendingTelegramTurn): Promise<void> {
    try {
      await this.agent.state.save(turn);
      await deliverPendingTelegramResponse(this.api, this.preview, turn, () => this.agent.state.save(turn));
      await this.completeActiveTurn(turn);
    } catch (error) {
      this.deliveryAttempts += 1;
      log(`response delivery failed (attempt ${this.deliveryAttempts}/${MAX_DELIVERY_ATTEMPTS}): ${this.errorText(error)}`);
      if (this.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS) {
        await this.abandonDelivery(turn, error);
        return;
      }
      if (!this.stopping && !this.deliveryRetryTimer) {
        this.deliveryRetryTimer = setTimeout(() => {
          this.deliveryRetryTimer = undefined;
          void this.deliverCompletedTurn(turn).catch((error: unknown) => {
            if (!this.stopping) this.onFatalError(error);
          });
        }, DELIVERY_RETRY_DELAY_MS);
      }
    }
  }

  private async abandonDelivery(turn: PendingTelegramTurn, error: unknown): Promise<void> {
    const dropped = turn.completedResponse?.queuedAttachments.length ?? 0;
    await this.api.sendTextReply(turn.chatId, turn.replyToMessageId,
      `Could not finish delivering this reply: ${this.errorText(error)}` + (dropped ? `\n\nDropped ${dropped} attachment(s).` : ""),
    ).catch((notifyError) => log(`failed to report delivery failure: ${this.errorText(notifyError)}`));
    await this.completeActiveTurn(turn);
  }

  private async completeActiveTurn(turn: PendingTelegramTurn): Promise<void> {
    if (this.activeTelegramTurn !== turn) return;
    // Do not advance the in-memory queue unless the receipt was committed.
    await this.agent.state.complete(turn.id);
    this.cancelDeliveryRetry();
    this.deliveryAttempts = 0;
    this.activeTelegramTurn = undefined;
  }

  private cancelDeliveryRetry(): void {
    if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
    this.deliveryRetryTimer = undefined;
  }

  private startNextTurnSafely(): void {
    void this.startNextTurnIfIdle().catch((error) => {
      log(`failed to start next Telegram turn: ${this.errorText(error)}`);
      if (!this.stopping) this.onFatalError(error);
    });
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
