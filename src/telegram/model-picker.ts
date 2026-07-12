import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { getOpenRouterPopularityRanks } from "../openrouter-rankings";
import { TelegramApi } from "./api";
import type {
  TelegramCallbackQuery,
  TelegramInlineKeyboardMarkup,
} from "./types";

export class TelegramModelPicker {
  private readonly pendingSearchChats = new Set<number>();
  private readonly queries = new Map<number, string>();

  constructor(
    private readonly api: TelegramApi,
    private readonly getSession: () => AgentSession,
  ) {}

  hasPendingSearch(chatId: number): boolean {
    return this.pendingSearchChats.has(chatId);
  }

  consumePendingSearch(chatId: number): void {
    this.pendingSearchChats.delete(chatId);
  }

  async show(
    chatId: number,
    replyToMessageId: number,
    page = 0,
  ): Promise<void> {
    if ((await this.getAvailableModels()).length === 0) {
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        "No authenticated models are available in Pi config.",
      );
      return;
    }
    await this.api.sendMessage(
      chatId,
      this.text(chatId),
      await this.markup(chatId, page),
      replyToMessageId,
    );
  }

  async showFiltered(
    chatId: number,
    replyToMessageId: number,
    query: string,
  ): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      this.queries.delete(chatId);
      await this.show(chatId, replyToMessageId);
      return;
    }
    const matches = await this.getAvailableModels(trimmed);
    if (matches.length === 0) {
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        `No available model matched "${trimmed}". Try another search or send /model.`,
      );
      return;
    }
    this.queries.set(chatId, trimmed);
    await this.show(chatId, replyToMessageId);
  }

  async selectByQuery(
    chatId: number,
    replyToMessageId: number,
    query: string,
  ): Promise<void> {
    const normalized = query.toLowerCase();
    const allMatches = await this.getAvailableModels(query);
    const exact = allMatches.find(
      (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
    );
    if (exact) {
      await this.getSession().setModel(exact);
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        `Model changed to ${exact.provider}/${exact.id}.`,
      );
      return;
    }
    if (allMatches.length === 1) {
      const [model] = allMatches;
      await this.getSession().setModel(model);
      await this.api.sendTextReply(
        chatId,
        replyToMessageId,
        `Model changed to ${model.provider}/${model.id}.`,
      );
      return;
    }
    await this.showFiltered(chatId, replyToMessageId, query);
  }

  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<boolean> {
    const data = query.data ?? "";
    const message = query.message;
    if (!message || !data.startsWith("model:")) return false;

    if (this.getSession().isStreaming) {
      await this.api.answerCallbackQuery(
        query.id,
        "Pi is busy. Send /stop first.",
      );
      return true;
    }

    const [, action, value] = data.split(":");
    if (action === "noop") {
      await this.api.answerCallbackQuery(query.id);
      return true;
    }
    if (action === "search") {
      this.pendingSearchChats.add(message.chat.id);
      await this.api.answerCallbackQuery(query.id, "Send search terms");
      await this.api.sendMessage(
        message.chat.id,
        "Send model search terms, e.g. `opus`, `gpt`, `anthropic`, or `gemini`.",
      );
      return true;
    }
    if (action === "clear") {
      this.queries.delete(message.chat.id);
      await this.api.editMessageText(
        message.chat.id,
        message.message_id,
        this.text(message.chat.id),
        await this.markup(message.chat.id, 0),
      );
      await this.api.answerCallbackQuery(query.id, "Search cleared");
      return true;
    }
    if (action === "page") {
      const page = Number(value ?? 0);
      await this.api.editMessageText(
        message.chat.id,
        message.message_id,
        this.text(message.chat.id),
        await this.markup(message.chat.id, Number.isFinite(page) ? page : 0),
      );
      await this.api.answerCallbackQuery(query.id);
      return true;
    }
    if (action === "set") {
      const index = Number(value);
      const text = await this.selectByIndex(
        message.chat.id,
        Number.isFinite(index) ? index : -1,
      );
      this.queries.delete(message.chat.id);
      await this.api.editMessageText(message.chat.id, message.message_id, text);
      await this.api.answerCallbackQuery(query.id, text);
      return true;
    }

    return false;
  }

  private async getAvailableModels(query?: string) {
    const normalized = query?.trim().toLowerCase();
    const ranks = await getOpenRouterPopularityRanks().catch(() => undefined);
    return this.getSession()
      .modelRegistry.getAvailable()
      .filter((model) => {
        if (!normalized) return true;
        return [
          model.provider,
          model.id,
          model.name,
          `${model.provider}/${model.id}`,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => {
        const rankA = this.getOpenRouterRank(a, ranks);
        const rankB = this.getOpenRouterRank(b, ranks);
        if (rankA !== rankB) return rankA - rankB;
        return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
      });
  }

  private getOpenRouterRank(
    model: { provider: string; id: string },
    ranks: Map<string, number> | undefined,
  ): number {
    if (!ranks) return Number.MAX_SAFE_INTEGER;
    const keys =
      model.provider === "openrouter"
        ? [model.id]
        : [`${model.provider}/${model.id}`];
    for (const key of keys) {
      const rank = ranks.get(key.toLowerCase());
      if (rank !== undefined) return rank;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private async markup(
    chatId: number,
    page: number,
  ): Promise<TelegramInlineKeyboardMarkup> {
    const activeQuery = this.queries.get(chatId);
    const models = await this.getAvailableModels(activeQuery);
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(models.length / pageSize));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const current = this.getSession().model;
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
      ...(activeQuery ? [{ text: "Clear", callback_data: "model:clear" }] : []),
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

  private text(chatId: number): string {
    const session = this.getSession();
    const current = session.model
      ? `${session.model.provider}/${session.model.id}`
      : "unknown";
    const activeQuery = this.queries.get(chatId);
    return [
      `Choose a Pi model. Current: ${current}`,
      activeQuery ? `Search: ${activeQuery}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async selectByIndex(chatId: number, index: number): Promise<string> {
    const model = (await this.getAvailableModels(this.queries.get(chatId)))[
      index
    ];
    if (!model) return "That model selection is no longer available.";
    await this.getSession().setModel(model);
    return `Model changed to ${model.provider}/${model.id}.`;
  }
}
