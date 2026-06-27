import { readFile, unlink, writeFile } from "node:fs/promises";

import type {
  AgentSession,
  AgentSessionEvent,
  createAgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

import { MAX_RICH_MESSAGE_LENGTH, PENDING_TURN_PATH } from "./constants";
import { log } from "./logger";
import {
  extractAssistantText,
  getMessageText,
  isAssistantMessage,
} from "./pi/session-messages";
import { createTelegramAttachTool } from "./pi/telegram-attach-tool";
import { createTelegramUiContext } from "./pi/ui-context";
import { TelegramApi } from "./telegram/api";
import { TelegramCommandHandler } from "./telegram/commands";
import { createTelegramTurn, sendQueuedAttachments } from "./telegram/files";
import { TelegramMediaGroupBuffer } from "./telegram/media-groups";
import { TelegramModelPicker } from "./telegram/model-picker";
import { TelegramPreviewManager } from "./telegram/preview";
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
          this.config.lastUpdateId = update.update_id;
          await this.saveConfig(this.config);
          await this.handleUpdate(update);
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
    this.preview.reset();
    this.progress.start(turn.chatId, turn.replyToMessageId);
    this.preview.startTypingLoop(turn.chatId);
    void session.sendUserMessage(turn.content).catch(async (error) => {
      this.preview.stopTypingLoop();
      this.progress.fail(
        error instanceof Error ? error.message : String(error),
      );
      this.activeTelegramTurn = undefined;
      await this.clearPendingTurn();
      await this.preview.clear(turn.chatId);
      await this.api.sendTextReply(
        turn.chatId,
        turn.replyToMessageId,
        error instanceof Error ? error.message : String(error),
      );
      void this.startNextTurnIfIdle();
    });
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
      this.preview.reset();
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
    const doneTurn = this.activeTelegramTurn;
    this.preview.stopTypingLoop();
    this.activeTelegramTurn = undefined;
    await this.clearPendingTurn();
    if (!doneTurn) {
      void this.startNextTurnIfIdle();
      return;
    }

    try {
      await this.sendCompletedTurn(event, doneTurn);
    } catch (error) {
      await this.reportAgentEndSendError(doneTurn, error);
    }
    void this.startNextTurnIfIdle();
  }

  private async sendCompletedTurn(
    event: AgentEndEvent,
    doneTurn: PendingTelegramTurn,
  ): Promise<void> {
    const assistant = extractAssistantText(event.messages);
    if (assistant.stopReason === "aborted") {
      this.progress.complete();
      await this.preview.clear(doneTurn.chatId);
      return;
    }

    if (assistant.stopReason === "error") {
      await this.sendAssistantError(
        doneTurn,
        assistant.errorMessage || "Pi failed while processing the request.",
      );
      return;
    }

    this.progress.complete();
    await this.sendAssistantText(doneTurn, assistant.text);
    await sendQueuedAttachments(this.api, doneTurn);
  }

  private async sendAssistantError(
    turn: PendingTelegramTurn,
    message: string,
  ): Promise<void> {
    this.progress.fail(message);
    await this.preview.clear(turn.chatId);
    await this.api.sendTextReply(turn.chatId, turn.replyToMessageId, message);
  }

  private async sendAssistantText(
    turn: PendingTelegramTurn,
    text: string | undefined,
  ): Promise<void> {
    if (this.preview.hasPreview) {
      this.preview.pendingText = text ?? this.preview.pendingText ?? "";
    }
    if (text && text.length <= MAX_RICH_MESSAGE_LENGTH) {
      await this.preview.finalize(turn.chatId);
      return;
    }

    await this.preview.clear(turn.chatId);
    if (text) await this.api.sendTextReply(turn.chatId, turn.replyToMessageId, text);
  }

  private async reportAgentEndSendError(
    turn: PendingTelegramTurn,
    error: unknown,
  ): Promise<void> {
    const message = `Failed to send response: ${this.errorText(error)}`;
    log(`agent_end send error: ${this.errorText(error)}`);
    this.progress.fail(message);
    await this.preview.clear(turn.chatId).catch(() => undefined);
    await this.api
      .sendTextReply(turn.chatId, turn.replyToMessageId, message)
      .catch(() => undefined);
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async restorePendingTurn(): Promise<boolean> {
    try {
      const data = await readFile(PENDING_TURN_PATH, "utf-8");
      const turn = JSON.parse(data) as PendingTelegramTurn;
      await this.clearPendingTurn();
      this.queuedTelegramTurns.unshift(turn);
      log("restored pending turn from previous session");
      await this.startNextTurnIfIdle();
      return true;
    } catch {
      return false;
    }
  }

  private async savePendingTurn(): Promise<void> {
    if (!this.activeTelegramTurn) return;
    try {
      await writeFile(
        PENDING_TURN_PATH,
        JSON.stringify(this.activeTelegramTurn),
        "utf-8",
      );
    } catch (e) {
      log(
        `failed to persist pending turn: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async clearPendingTurn(): Promise<void> {
    try {
      await unlink(PENDING_TURN_PATH);
    } catch {
      // ignore missing file
    }
  }

  private requireRuntime(): Runtime {
    if (!this.runtime) throw new Error("Runtime is not initialized");
    return this.runtime;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Session is not initialized");
    return this.session;
  }
}
