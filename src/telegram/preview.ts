import {
  MAX_MESSAGE_LENGTH,
  MAX_RICH_MESSAGE_LENGTH,
  PREVIEW_THROTTLE_MS,
  TELEGRAM_DRAFT_ID_MAX,
} from "../constants";
import { log } from "../logger";
import { TelegramApi, TelegramApiError } from "./api";
import { legacyTextChunks } from "./text-chunks";
import type { TelegramPreviewState } from "./types";

/** Ephemeral UI only. Authoritative replies are sent by the durable outbox. */
export class TelegramPreviewManager {
  private state: TelegramPreviewState | undefined;
  private draftSupport = true;
  private richDraftSupport = true;
  private nextDraftId = 0;
  private typingInterval: ReturnType<typeof setInterval> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly retired: Array<{ chatId: number; state: TelegramPreviewState }> = [];

  constructor(
    private readonly api: TelegramApi,
    private readonly recordMessage: (chatId: number, messageId: number) => Promise<void> = async () => {},
  ) {}

  restoreMessages(chatId: number, messageIds: number[]): void {
    for (const messageId of messageIds)
      this.retired.push({ chatId, state: { mode: "message", messageId, pendingText: "", lastSentText: "" } });
  }

  get hasPreview(): boolean { return this.state !== undefined; }
  get pendingText(): string | undefined { return this.state?.pendingText; }
  set pendingText(text: string) {
    if (!this.state) this.reset();
    this.state!.pendingText = text;
  }

  reset(replyToMessageId?: number): void {
    this.discard();
    this.state = { mode: this.draftSupport ? "draft" : "message", replyToMessageId, pendingText: "", lastSentText: "" };
  }

  discard(): void {
    if (this.state?.flushTimer) clearTimeout(this.state.flushTimer);
    this.state = undefined;
  }

  startTypingLoop(chatId?: number): void {
    if (this.typingInterval || chatId === undefined) return;
    const sendTyping = () => this.api.call("sendChatAction", { chat_id: chatId, action: "typing" })
      .catch((error: unknown) => log(`typing failed: ${String(error)}`));
    void sendTyping();
    this.typingInterval = setInterval(() => void sendTyping(), 4000);
  }

  stopTypingLoop(): void {
    if (this.typingInterval) clearInterval(this.typingInterval);
    this.typingInterval = undefined;
  }

  async clear(chatId: number): Promise<void> {
    const state = this.state;
    if (state) {
      this.discard();
      this.retired.push({ chatId, state });
    }
    // Queue behind any in-flight flush: it may not have its message ID yet.
    await this.enqueue(async () => {
      for (const item of [...this.retired]) {
        if (item.chatId !== chatId) continue;
        await this.clearState(chatId, item.state);
        this.retired.splice(this.retired.indexOf(item), 1);
      }
    });
  }

  scheduleFlush(chatId: number): void {
    const state = this.state;
    if (!state || state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      void this.enqueue(async () => {
        if (this.state === state) await this.flushState(chatId, state);
      }).catch((error: unknown) => log(`preview update failed: ${String(error)}`));
    }, PREVIEW_THROTTLE_MS);
  }

  private async flushState(chatId: number, state: TelegramPreviewState): Promise<void> {
    const text = state.pendingText.trim();
    if (!text || text === state.lastSentText) return;
    const richText = text.slice(0, MAX_RICH_MESSAGE_LENGTH).replace(/[\uD800-\uDBFF]$/u, "");
    const legacyText = text.slice(0, MAX_MESSAGE_LENGTH).replace(/[\uD800-\uDBFF]$/u, "");
    state.draftId ??= this.nextDraftId = this.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : this.nextDraftId + 1;
    if (this.richDraftSupport) {
      try {
        await this.api.sendRichMessageDraft(chatId, state.draftId, richText);
        state.mode = "draft";
        state.draftKind = "rich";
        state.lastSentText = richText;
        return;
      } catch (error) {
        if (!this.unavailable(error)) throw error;
        this.richDraftSupport = false;
      }
    }
    if (this.draftSupport) {
      try {
        await this.api.call("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: legacyText });
        state.mode = "draft";
        state.draftKind = "legacy";
        state.lastSentText = legacyText;
        return;
      } catch (error) {
        if (!this.unavailable(error)) throw error;
        this.draftSupport = false;
      }
    }
    // A fallback preview must fit one physical message, including HTML expansion.
    const messageText = legacyTextChunks(legacyText)[0];
    if (state.messageId === undefined) {
      const sent = await this.api.sendMessage(chatId, messageText, undefined, state.replyToMessageId);
      state.messageId = sent.message_id;
      await this.recordMessage(chatId, sent.message_id);
    } else if (messageText !== state.lastSentText) {
      await this.api.editMessageText(chatId, state.messageId, messageText);
    }
    state.mode = "message";
    state.lastSentText = messageText;
  }

  private async clearState(chatId: number, state: TelegramPreviewState): Promise<void> {
    try {
      if (state.messageId !== undefined) await this.api.deleteMessage(chatId, state.messageId);
      if (state.draftKind === "rich") await this.api.sendRichMessageDraft(chatId, state.draftId!, "");
      if (state.draftKind === "legacy")
        await this.api.call("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
    } catch (error) {
      // Gone/unsupported previews need no cleanup; transient failures remain
      // retired so a later clear (including final delivery) retries them.
      if (!(error instanceof TelegramApiError && error.permanent) && !this.unavailable(error)) throw error;
    }
  }

  private unavailable(error: unknown): boolean {
    return error instanceof Error && /method not found|unsupported|can't find method|^not found$/i.test(error.message);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
