import type {
  AgentSession,
  AgentSessionEvent,
  createAgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

import { log } from "./logger";
import { readPendingTurn, removePendingTurn, writePendingTurn } from "./pending-turn";
import {
  extractAssistantText,
  getMessageText,
  isAssistantMessage,
} from "./pi/session-messages";
import { createTelegramAttachTool } from "./pi/telegram-attach-tool";
import { createTelegramUiContext } from "./pi/ui-context";
import { TelegramApi } from "./telegram/api";
import { TelegramCommandHandler } from "./telegram/commands";
import { createTelegramTurn } from "./telegram/files";
import { TelegramMediaGroupBuffer } from "./telegram/media-groups";
import { TelegramModelPicker } from "./telegram/model-picker";
import { TelegramPreviewManager } from "./telegram/preview";
import { deliverPendingTelegramResponse } from "./telegram/response-delivery";
import { TelegramProgressManager } from "./telegram/progress";
import type {
  PendingTelegramTurn,
  TelegramCallbackQuery,
  TelegramConfig,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram/types";

type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;
type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;

export class TelegramBridge {
  readonly api: TelegramApi;
  readonly preview: TelegramPreviewManager;
  readonly progress: TelegramProgressManager;
  readonly attachTool = createTelegramAttachTool(() => this.activeTelegramTurn);

  private runtime: Runtime | undefined;
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private queuedTelegramTurns: PendingTelegramTurn[] = [];
  private activeTelegramTurn: PendingTelegramTurn | undefined;
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly failedUpdateAttempts = new Map<number, number>();
  private preserveQueuedTurnsAsHistory = false;
  private readonly commandHandler: TelegramCommandHandler;
  private readonly mediaGroups: TelegramMediaGroupBuffer;
  private readonly modelPicker: TelegramModelPicker;

  constructor(
    private readonly config: TelegramConfig,
    private readonly saveConfig: (config: TelegramConfig) => Promise<void>,
    private readonly onShutdown: () => void,
  ) {
    this.api = new TelegramApi(() => this.config);
    this.preview = new TelegramPreviewManager(this.api);
    this.progress = new TelegramProgressManager(this.api);
    this.mediaGroups = new TelegramMediaGroupBuffer((messages) =>
      this.dispatchAuthorizedTelegramMessages(messages),
    );
    this.modelPicker = new TelegramModelPicker(this.api, () =>
      this.requireSession(),
    );
    this.commandHandler = new TelegramCommandHandler(
      this.api,
      this.modelPicker,
      {
        bindSession: () => this.bindSession(),
        clearActiveTurn: () => {
          this.activeTelegramTurn = undefined;
          this.cancelDeliveryRetry();
          void this.clearPendingTurn();
        },
        clearQueuedTurns: () => {
          this.queuedTelegramTurns = [];
        },
        discardPreview: () => this.preview.discard(),
        getQueueLength: () => this.queuedTelegramTurns.length,
        getSession: () => this.requireSession(),
        newSession: () => this.requireRuntime().newSession(),
        preserveQueuedTurnsAsHistory: () => {
          this.preserveQueuedTurnsAsHistory = true;
        },
      },
    );
  }

  get currentSession(): AgentSession | undefined {
    return this.session;
  }

  setRuntime(runtime: Runtime): void {
    this.runtime = runtime;
  }

  async bindSession(): Promise<void> {
    const runtime = this.requireRuntime();
    this.unsubscribe?.();
    this.session = runtime.session;
    const session = this.session;
    await session.bindExtensions({
      uiContext: createTelegramUiContext(
        this.progress,
        () => this.activeTelegramTurn !== undefined,
      ),
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: async (entryId, options) => ({
          cancelled: (await runtime.fork(entryId, options)).cancelled,
        }),
        navigateTree: async (targetId, options) => ({
          cancelled: (await session.navigateTree(targetId, options)).cancelled,
        }),
        switchSession: (path, options) => runtime.switchSession(path, options),
        reload: () => session.reload(),
      },
      shutdownHandler: this.onShutdown,
      onError: (e) =>
        log(`extension error ${e.extensionPath} ${e.event}: ${e.error}`),
    });
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(event));
  }

  async pollLoop(signal: AbortSignal): Promise<void> {
    if (!this.config.botToken)
      throw new Error("Telegram bot token is not configured");
    await this.api
      .call("deleteWebhook", { drop_pending_updates: false }, { signal })
      .catch(() => undefined);
    await this.api.configureCommands(signal);
    if (this.config.lastUpdateId === undefined) {
      const updates = await this.api
        .call<
          TelegramUpdate[]
        >("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal })
        .catch(() => []);
      const last = updates.at(-1);
      if (last) {
        this.config.lastUpdateId = last.update_id;
        await this.saveConfig(this.config);
      }
    }
    log("telegram polling started");
    while (!signal.aborted) {
      try {
        const updates = await this.api.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset:
              this.config.lastUpdateId !== undefined
                ? this.config.lastUpdateId + 1
                : undefined,
            limit: 10,
            timeout: 30,
            allowed_updates: ["message", "edited_message", "callback_query"],
          },
          { signal },
        );
        for (const update of updates) {
          try {
            await this.handleUpdate(update);
            this.failedUpdateAttempts.delete(update.update_id);
          } catch (error) {
            const attempts =
              (this.failedUpdateAttempts.get(update.update_id) ?? 0) + 1;
            if (attempts < 3) {
              this.failedUpdateAttempts.set(update.update_id, attempts);
              throw error;
            }
            this.failedUpdateAttempts.delete(update.update_id);
            log(
              `skipping update ${update.update_id} after ${attempts} failed attempts: ${this.errorText(error)}`,
            );
          }
          this.config.lastUpdateId = update.update_id;
          await this.saveConfig(this.config);
        }
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        )
          return;
        log(
          `polling error: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  async shutdown(): Promise<void> {
    this.cancelDeliveryRetry();
    this.preview.stopTypingLoop();
    this.progress.discard();
    this.unsubscribe?.();
    this.mediaGroups.discard();
    if (this.activeTelegramTurn) {
      await this.savePendingTurn();
      await this.preview
        .clear(this.activeTelegramTurn.chatId)
        .catch(() => undefined);
    }
  }

  private async startNextTurnIfIdle(): Promise<void> {
    const session = this.requireSession();
    if (
      session.isStreaming ||
      this.activeTelegramTurn ||
      this.queuedTelegramTurns.length === 0
    )
      return;
    const turn = this.queuedTelegramTurns.shift();
    if (!turn) return;
    this.activeTelegramTurn = turn;
    await this.savePendingTurn();
    this.preview.reset(turn.replyToMessageId);
    this.progress.start(turn.chatId, turn.replyToMessageId);
    this.preview.startTypingLoop(turn.chatId);
    void session.sendUserMessage(turn.content).catch((error) =>
      this.handleTurnStartError(turn, error),
    );
  }

  private async dispatchAuthorizedTelegramMessages(
    messages: TelegramMessage[],
  ): Promise<void> {
    if (await this.commandHandler.handle(messages)) return;

    const historyTurns = this.preserveQueuedTurnsAsHistory
      ? this.queuedTelegramTurns.splice(0)
      : [];
    this.preserveQueuedTurnsAsHistory = false;
    this.queuedTelegramTurns.push(
      await createTelegramTurn(this.api, messages, historyTurns),
    );
    await this.startNextTurnIfIdle();
  }

  private async handleAuthorizedTelegramMessage(
    message: TelegramMessage,
  ): Promise<void> {
    if (this.mediaGroups.handle(message)) return;
    await this.dispatchAuthorizedTelegramMessages([message]);
  }

  private async handleAuthorizedCallbackQuery(
    query: TelegramCallbackQuery,
  ): Promise<void> {
    const data = query.data ?? "";
    const message = query.message;
    if (!message) return;
    if (data === "turn:stop") {
      const session = this.requireSession();
      if (session.isStreaming) {
        if (this.queuedTelegramTurns.length)
          this.preserveQueuedTurnsAsHistory = true;
        await session.abort();
        await this.api.answerCallbackQuery(query.id, "Aborting current turn…");
      } else {
        await this.api.answerCallbackQuery(query.id, "No active turn.");
      }
      return;
    }
    await this.modelPicker.handleCallbackQuery(query);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      if (callbackQuery.from.is_bot) return;
      if (this.config.allowedUserId === undefined) {
        this.config.allowedUserId = callbackQuery.from.id;
        await this.saveConfig(this.config);
      }
      if (callbackQuery.from.id !== this.config.allowedUserId) {
        await this.api.answerCallbackQuery(
          callbackQuery.id,
          "This bot is not authorized for your account.",
        );
        return;
      }
      await this.handleAuthorizedCallbackQuery(callbackQuery);
      return;
    }

    const message = update.message || update.edited_message;
    if (
      !message ||
      message.chat.type !== "private" ||
      !message.from ||
      message.from.is_bot
    )
      return;
    if (this.config.allowedUserId === undefined) {
      this.config.allowedUserId = message.from.id;
      await this.saveConfig(this.config);
      await this.api.sendTextReply(
        message.chat.id,
        message.message_id,
        "Telegram bridge paired with this account.",
      );
    }
    if (message.from.id !== this.config.allowedUserId) {
      await this.api.sendTextReply(
        message.chat.id,
        message.message_id,
        "This bot is not authorized for your account.",
      );
      return;
    }
    await this.handleAuthorizedTelegramMessage(message);
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    this.handleMessageSessionEvent(event);
    this.handleToolSessionEvent(event);
    this.handleStatusSessionEvent(event);
    if (event.type === "agent_end") void this.handleAgentEnd(event);
  }

  private handleMessageSessionEvent(event: AgentSessionEvent): void {
    const turn = this.activeTelegramTurn;
    if (!turn) return;

    if (event.type === "message_start") {
      if (!isAssistantMessage(event.message)) return;
      this.progress.markAssistantStreaming();
      if (this.preview.hasVisibleText()) void this.preview.finalize(turn.chatId);
      this.preview.reset(turn.replyToMessageId);
      return;
    }

    if (event.type !== "message_update" || !isAssistantMessage(event.message)) {
      return;
    }

    const assistantEvent = event.assistantMessageEvent;
    if (
      assistantEvent.type === "thinking_start" ||
      assistantEvent.type === "thinking_delta"
    ) {
      this.progress.markThinking(true);
    } else if (assistantEvent.type === "thinking_end") {
      this.progress.markThinking(false);
    } else if (assistantEvent.type.startsWith("text_")) {
      this.progress.markAssistantStreaming();
    } else if (assistantEvent.type.startsWith("toolcall_")) {
      this.progress.setStatus("tool-call", "Preparing a tool call…");
    }
    this.preview.pendingText = getMessageText(event.message);
    this.preview.scheduleFlush(turn.chatId);
  }

  private handleToolSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start":
        this.progress.toolStart(event.toolCallId, event.toolName, event.args);
        return;
      case "tool_execution_update":
        this.progress.toolUpdate(event.toolCallId, event.toolName, event.args);
        return;
      case "tool_execution_end":
        this.progress.toolEnd(
          event.toolCallId,
          event.toolName,
          event.result,
          event.isError,
        );
    }
  }

  private handleStatusSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "compaction_start":
        this.progress.setStatus(
          "compaction",
          `Compacting context (${event.reason})…`,
        );
        return;
      case "compaction_end":
        this.progress.setStatus("compaction", this.compactionStatus(event));
        return;
      case "auto_retry_start":
        this.progress.setStatus(
          "retry",
          `Retrying after error (${event.attempt}/${event.maxAttempts})…`,
        );
        return;
      case "auto_retry_end":
        this.progress.setStatus(
          "retry",
          event.success
            ? "Retry succeeded"
            : (event.finalError ?? "Retry failed"),
        );
    }
  }

  private compactionStatus(
    event: Extract<AgentSessionEvent, { type: "compaction_end" }>,
  ): string {
    if (event.aborted) return "Compaction aborted";
    return event.errorMessage
      ? `Compaction failed: ${event.errorMessage}`
      : "Compaction complete";
  }

  private async handleAgentEnd(event: AgentEndEvent): Promise<void> {
    const turn = this.activeTelegramTurn;
    this.preview.stopTypingLoop();
    if (!turn) return void this.startNextTurnIfIdle();

    const assistant = extractAssistantText(event.messages);
    if (assistant.stopReason === "aborted") {
      this.progress.complete();
      await this.preview.clear(turn.chatId);
      await this.completeActiveTurn(turn);
      return;
    }

    const text =
      assistant.stopReason === "error"
        ? (assistant.errorMessage || "Pi failed while processing the request.")
        : assistant.text;
    if (assistant.stopReason === "error")
      this.progress.fail(text || "Pi failed while processing the request.");
    else this.progress.complete();
    turn.completedResponse = {
      text,
      textDelivered: false,
      queuedAttachments:
        assistant.stopReason === "error" ? [] : [...turn.queuedAttachments],
    };
    await this.savePendingTurn();
    await this.deliverCompletedTurn(turn);
  }

  private async handleTurnStartError(
    turn: PendingTelegramTurn,
    error: unknown,
  ): Promise<void> {
    if (this.activeTelegramTurn !== turn) return;
    const text = this.errorText(error);
    this.preview.stopTypingLoop();
    this.progress.fail(text);
    await this.preview.clear(turn.chatId);
    turn.completedResponse = {
      text,
      textDelivered: false,
      queuedAttachments: [],
    };
    await this.savePendingTurn();
    await this.deliverCompletedTurn(turn);
  }

  private async deliverCompletedTurn(turn: PendingTelegramTurn): Promise<void> {
    const response = turn.completedResponse;
    if (!response || this.activeTelegramTurn !== turn) return;
    try {
      await deliverPendingTelegramResponse(
        this.api,
        this.preview,
        turn,
        () => this.savePendingTurn(),
      );
      await this.completeActiveTurn(turn);
    } catch (error) {
      log(`response delivery failed: ${this.errorText(error)}`);
      this.scheduleDeliveryRetry(turn);
    }
  }

  private scheduleDeliveryRetry(turn: PendingTelegramTurn): void {
    if (this.deliveryRetryTimer) return;
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = undefined;
      void this.deliverCompletedTurn(turn);
    }, 5000);
  }

  private cancelDeliveryRetry(): void {
    if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
    this.deliveryRetryTimer = undefined;
  }

  private async completeActiveTurn(turn: PendingTelegramTurn): Promise<void> {
    if (this.activeTelegramTurn !== turn) return;
    this.cancelDeliveryRetry();
    this.activeTelegramTurn = undefined;
    await this.clearPendingTurn();
    void this.startNextTurnIfIdle();
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async restorePendingTurn(): Promise<boolean> {
    const turn = await readPendingTurn();
    if (!turn) return false;
    if (turn.completedResponse) {
      this.activeTelegramTurn = turn;
      log("restored pending response delivery from previous session");
      await this.deliverCompletedTurn(turn);
      return true;
    }
    await this.clearPendingTurn();
    this.queuedTelegramTurns.unshift(turn);
    log("restored pending turn from previous session");
    await this.startNextTurnIfIdle();
    return true;
  }

  private async savePendingTurn(): Promise<void> {
    if (!this.activeTelegramTurn) return;
    await writePendingTurn(this.activeTelegramTurn).catch((error) =>
      log(`failed to persist pending turn: ${this.errorText(error)}`),
    );
  }

  private async clearPendingTurn(): Promise<void> {
    await removePendingTurn();
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw new Error("Runtime is not initialized");
    return this.runtime;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Session is not initialized");
    return this.session;
  }

  // eslint-disable-next-line max-lines -- The bridge owns the Telegram/session lifecycle.
}
