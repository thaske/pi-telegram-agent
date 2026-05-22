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
  TelegramCallbackQuery,
  TelegramConfig,
  TelegramInlineKeyboardMarkup,
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
  private pendingModelSearchChats = new Set<number>();
  private modelPickerQueries = new Map<number, string>();

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
    if (
      this.pendingModelSearchChats.has(firstMessage.chat.id) &&
      !lower.startsWith("/")
    ) {
      this.pendingModelSearchChats.delete(firstMessage.chat.id);
      if (session.isStreaming) {
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Cannot change models while pi is busy. Send /stop first.",
        );
        return;
      }
      await this.showFilteredModelPicker(
        firstMessage.chat.id,
        firstMessage.message_id,
        rawText,
      );
      return;
    }
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
    if (lower === "/model" || lower === "model") {
      if (session.isStreaming) {
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Cannot change models while pi is busy. Send /stop first.",
        );
        return;
      }
      await this.showModelPicker(firstMessage.chat.id, firstMessage.message_id);
      return;
    }
    if (lower.startsWith("/model ") || lower.startsWith("model ")) {
      if (session.isStreaming) {
        await this.api.sendTextReply(
          firstMessage.chat.id,
          firstMessage.message_id,
          "Cannot change models while pi is busy. Send /stop first.",
        );
        return;
      }
      const query = rawText.replace(/^\/?model\s+/i, "").trim();
      await this.selectModelByQuery(
        firstMessage.chat.id,
        firstMessage.message_id,
        query,
      );
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
        "Send me a message and I will forward it to Pi. Commands: /new, /status, /model, /compact, /stop, /help.",
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

  private getAvailableModels(query?: string) {
    const normalized = query?.trim().toLowerCase();
    return this.requireSession()
      .modelRegistry.getAvailable()
      .filter((model) => {
        if (!normalized) return true;
        return [model.provider, model.id, model.name, `${model.provider}/${model.id}`]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) =>
        `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
      );
  }

  private modelPickerMarkup(
    chatId: number,
    page: number,
  ): TelegramInlineKeyboardMarkup {
    const activeQuery = this.modelPickerQueries.get(chatId);
    const models = this.getAvailableModels(activeQuery);
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const current = this.requireSession().model;
    const rows = models
      .slice(safePage * pageSize, safePage * pageSize + pageSize)
      .map((model, i) => {
        const index = safePage * pageSize + i;
        const selected =
          current?.provider === model.provider && current?.id === model.id;
        return [
          {
            text: `${selected ? "✓ " : ""}${model.name} (${model.provider})`,
            callback_data: `model:set:${index}`,
          },
        ];
      });
    rows.push([
      { text: "🔎 Search", callback_data: "model:search" },
      ...(activeQuery
        ? [{ text: "Clear", callback_data: "model:clear" }]
        : []),
    ]);
    if (pageCount > 1) {
      rows.push([
        {
          text: "‹ Prev",
          callback_data: `model:page:${(safePage - 1 + pageCount) % pageCount}`,
        },
        { text: `${safePage + 1}/${pageCount}`, callback_data: "model:noop" },
        {
          text: "Next ›",
          callback_data: `model:page:${(safePage + 1) % pageCount}`,
        },
      ]);
    }
    return { inline_keyboard: rows };
  }

  private modelPickerText(chatId: number): string {
    const session = this.requireSession();
    const current = session.model
      ? `${session.model.provider}/${session.model.id}`
      : "unknown";
    const activeQuery = this.modelPickerQueries.get(chatId);
    return [
      `Choose a Pi model. Current: ${current}`,
      activeQuery ? `Search: ${activeQuery}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async showModelPicker(
    chatId: number,
    replyToMessageId: number,
    page = 0,
  ): Promise<void> {
    if (this.getAvailableModels().length === 0) {
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        "No authenticated models are available in Pi config.",
      );
      return;
    }
    await this.api.sendMessage(
      chatId,
      this.modelPickerText(chatId),
      this.modelPickerMarkup(chatId, page),
    );
  }

  private async showFilteredModelPicker(
    chatId: number,
    replyToMessageId: number,
    query: string,
  ): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      this.modelPickerQueries.delete(chatId);
      await this.showModelPicker(chatId, replyToMessageId);
      return;
    }
    const matches = this.getAvailableModels(trimmed);
    if (matches.length === 0) {
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        `No available model matched "${trimmed}". Try another search or send /model.`,
      );
      return;
    }
    this.modelPickerQueries.set(chatId, trimmed);
    await this.showModelPicker(chatId, replyToMessageId);
  }

  private async selectModelByIndex(
    chatId: number,
    index: number,
  ): Promise<string> {
    const session = this.requireSession();
    const model = this.getAvailableModels(this.modelPickerQueries.get(chatId))[index];
    if (!model) return "That model selection is no longer available.";
    await session.setModel(model);
    return `Model changed to ${model.provider}/${model.id}.`;
  }

  private async selectModelByQuery(
    chatId: number,
    replyToMessageId: number,
    query: string,
  ): Promise<void> {
    const normalized = query.toLowerCase();
    const allMatches = this.getAvailableModels(query);
    const exact = allMatches.find(
      (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
    );
    if (exact) {
      await this.requireSession().setModel(exact);
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        `Model changed to ${exact.provider}/${exact.id}.`,
      );
      return;
    }
    if (allMatches.length === 1) {
      await this.requireSession().setModel(allMatches[0]!);
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        `Model changed to ${allMatches[0]!.provider}/${allMatches[0]!.id}.`,
      );
      return;
    }
    await this.showFilteredModelPicker(chatId, replyToMessageId, query);
  }

  private async handleAuthorizedCallbackQuery(
    query: TelegramCallbackQuery,
  ): Promise<void> {
    const data = query.data ?? "";
    const message = query.message;
    if (!message || !data.startsWith("model:")) return;
    if (this.requireSession().isStreaming) {
      await this.api.answerCallbackQuery(
        query.id,
        "Pi is busy. Send /stop first.",
      );
      return;
    }
    const [, action, value] = data.split(":");
    if (action === "noop") {
      await this.api.answerCallbackQuery(query.id);
      return;
    }
    if (action === "search") {
      this.pendingModelSearchChats.add(message.chat.id);
      await this.api.answerCallbackQuery(query.id, "Send search terms");
      await this.api.sendMessage(
        message.chat.id,
        "Send model search terms, e.g. `opus`, `gpt`, `anthropic`, or `gemini`.",
      );
      return;
    }
    if (action === "clear") {
      this.modelPickerQueries.delete(message.chat.id);
      await this.api.editMessageText(
        message.chat.id,
        message.message_id,
        this.modelPickerText(message.chat.id),
        this.modelPickerMarkup(message.chat.id, 0),
      );
      await this.api.answerCallbackQuery(query.id, "Search cleared");
      return;
    }
    if (action === "page") {
      const page = Number(value ?? 0);
      await this.api.editMessageText(
        message.chat.id,
        message.message_id,
        this.modelPickerText(message.chat.id),
        this.modelPickerMarkup(
          message.chat.id,
          Number.isFinite(page) ? page : 0,
        ),
      );
      await this.api.answerCallbackQuery(query.id);
      return;
    }
    if (action === "set") {
      const index = Number(value);
      const text = await this.selectModelByIndex(
        message.chat.id,
        Number.isFinite(index) ? index : -1,
      );
      this.modelPickerQueries.delete(message.chat.id);
      await this.api.editMessageText(message.chat.id, message.message_id, text);
      await this.api.answerCallbackQuery(query.id, text);
    }
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
