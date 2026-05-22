import type {
  AgentSession,
  AgentSessionEvent,
  createAgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";

import {
  MAX_MESSAGE_LENGTH,
  TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS,
} from "./constants.js";
import { log } from "./logger.js";
import {
  extractAssistantText,
  getMessageText,
  isAssistantMessage,
} from "./pi/session-messages.js";
import { createTelegramAttachTool } from "./pi/telegram-attach-tool.js";
import { TelegramApi } from "./telegram/api.js";
import { createTelegramTurn, sendQueuedAttachments } from "./telegram/files.js";
import { TelegramPreviewManager } from "./telegram/preview.js";
import type {
  PendingTelegramTurn,
  TelegramConfig,
  TelegramMediaGroupState,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram/types.js";

type Runtime = Awaited<ReturnType<typeof createAgentSessionRuntime>>;

export class TelegramBridge {
  readonly api: TelegramApi;
  readonly preview: TelegramPreviewManager;
  readonly attachTool = createTelegramAttachTool(() => this.activeTelegramTurn);

  private runtime: Runtime | undefined;
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private queuedTelegramTurns: PendingTelegramTurn[] = [];
  private activeTelegramTurn: PendingTelegramTurn | undefined;
  private preserveQueuedTurnsAsHistory = false;
  private mediaGroups = new Map<string, TelegramMediaGroupState>();

  constructor(
    private readonly config: TelegramConfig,
    private readonly saveConfig: (config: TelegramConfig) => Promise<void>,
    private readonly onShutdown: () => void,
  ) {
    this.api = new TelegramApi(() => this.config);
    this.preview = new TelegramPreviewManager(this.api);
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
      uiContext: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify: (m, t) => log(`notify:${t ?? "info"}: ${m}`),
        onTerminalInput: () => () => undefined,
        setStatus: () => undefined,
        setWorkingMessage: () => undefined,
        setWorkingVisible: () => undefined,
        setWorkingIndicator: () => undefined,
        setHiddenThinkingLabel: () => undefined,
        setWidget: () => undefined,
        setFooter: () => undefined,
        setHeader: () => undefined,
        setTitle: () => undefined,
        custom: async <T>() => undefined as T,
        pasteToEditor: () => undefined,
        setEditorText: () => undefined,
        getEditorText: () => "",
        editor: async () => undefined,
        addAutocompleteProvider: () => undefined,
        setEditorComponent: () => undefined,
        getEditorComponent: () => undefined,
        get theme() {
          return {} as never;
        },
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: false, error: "not supported" }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => undefined,
      },
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
            allowed_updates: ["message", "edited_message"],
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
    this.unsubscribe?.();
    if (this.activeTelegramTurn)
      await this.preview
        .clear(this.activeTelegramTurn.chatId)
        .catch(() => undefined);
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
    this.preview.reset();
    this.preview.startTypingLoop(turn.chatId);
    void session.sendUserMessage(turn.content).catch(async (error) => {
      this.preview.stopTypingLoop();
      this.activeTelegramTurn = undefined;
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
    const session = this.requireSession();
    const firstMessage = messages[0];
    if (!firstMessage) return;
    const rawText =
      messages.map((m) => (m.text || m.caption || "").trim()).find(Boolean) ||
      "";
    const lower = rawText.toLowerCase();
    if (lower === "stop" || lower === "/stop") {
      if (session.isStreaming) {
        if (this.queuedTelegramTurns.length)
          this.preserveQueuedTurnsAsHistory = true;
        await session.abort();
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Aborted current turn.",
        );
      } else
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "No active turn.",
        );
      return;
    }
    if (lower === "/new" || lower === "new" || lower === "/reset") {
      if (session.isStreaming) {
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Cannot start a new chat while pi is busy. Send /stop first.",
        );
        return;
      }
      await this.api.sendTextReply(
        firstMessage.chat.id,
        firstMessage.message_id,
        "Starting a new Pi chat...",
      );
      this.queuedTelegramTurns = [];
      this.activeTelegramTurn = undefined;
      this.preview.discard();
      const result = await this.requireRuntime().newSession();
      if (!result.cancelled)
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "New Pi chat started.",
        );
      await this.bindSession();
      return;
    }
    if (lower === "/compact") {
      if (session.isStreaming) {
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Cannot compact while pi is busy. Send /stop first.",
        );
        return;
      }
      await this.api.sendTextReply(
        firstMessage.chat.id,
        firstMessage.message_id,
        "Compaction started.",
      );
      try {
        await session.compact();
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Compaction completed.",
        );
      } catch (e) {
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          `Compaction failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }
    if (lower === "/status") {
      const stats = session.getSessionStats();
      const usage = session.getContextUsage();
      const lines = [
        `Model: ${session.model ? `${session.model.provider}/${session.model.id}` : "unknown"}`,
        `Messages: ${stats.totalMessages}`,
        `Cost: $${stats.cost.toFixed(3)}`,
      ];
      if (usage)
        lines.push(
          `Context: ${usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?"}/${usage.contextWindow ?? session.model?.contextWindow ?? "?"}`,
        );
      await this.api.sendTextReply(
        firstMessage.chat.id,
        firstMessage.message_id,
        lines.join("\n"),
      );
      return;
    }
    if (lower === "/help" || lower === "/start") {
      await this.api.sendTextReply(
        firstMessage.chat.id,
        firstMessage.message_id,
        "Send me a message and I will forward it to Pi. Commands: /new, /status, /compact, /stop, /help.",
      );
      return;
    }
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
    if (message.media_group_id) {
      const key = `${message.chat.id}:${message.media_group_id}`;
      const existing = this.mediaGroups.get(key) ?? { messages: [] };
      existing.messages.push(message);
      if (existing.flushTimer) clearTimeout(existing.flushTimer);
      existing.flushTimer = setTimeout(() => {
        const state = this.mediaGroups.get(key);
        this.mediaGroups.delete(key);
        if (state) void this.dispatchAuthorizedTelegramMessages(state.messages);
      }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
      this.mediaGroups.set(key, existing);
      return;
    }
    await this.dispatchAuthorizedTelegramMessages([message]);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
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
    const turn = this.activeTelegramTurn;
    if (
      event.type === "message_start" &&
      turn &&
      isAssistantMessage(event.message)
    ) {
      if (this.preview.hasVisibleText())
        void this.preview.finalize(turn.chatId);
      this.preview.reset();
    }
    if (
      event.type === "message_update" &&
      turn &&
      isAssistantMessage(event.message)
    ) {
      this.preview.pendingText = getMessageText(event.message);
      this.preview.scheduleFlush(turn.chatId);
    }
    if (event.type === "agent_end") {
      void (async () => {
        const doneTurn = this.activeTelegramTurn;
        this.preview.stopTypingLoop();
        this.activeTelegramTurn = undefined;
        if (!doneTurn) return;
        const assistant = extractAssistantText(event.messages);
        if (assistant.stopReason === "aborted") {
          await this.preview.clear(doneTurn.chatId);
          void this.startNextTurnIfIdle();
          return;
        }
        if (assistant.stopReason === "error") {
          await this.preview.clear(doneTurn.chatId);
          await this.api.sendTextReply(
            doneTurn.chatId,
            doneTurn.replyToMessageId,
            assistant.errorMessage || "Pi failed while processing the request.",
          );
          void this.startNextTurnIfIdle();
          return;
        }
        const finalText = assistant.text;
        if (this.preview.hasPreview)
          this.preview.pendingText =
            finalText ?? this.preview.pendingText ?? "";
        if (finalText && finalText.length <= MAX_MESSAGE_LENGTH)
          await this.preview.finalize(doneTurn.chatId);
        else {
          await this.preview.clear(doneTurn.chatId);
          if (finalText)
            await this.api.sendTextReply(
              doneTurn.chatId,
              doneTurn.replyToMessageId,
              finalText,
            );
        }
        await sendQueuedAttachments(this.api, doneTurn);
        void this.startNextTurnIfIdle();
      })();
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
