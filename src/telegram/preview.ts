import {
  MAX_MESSAGE_LENGTH,
  MAX_RICH_MESSAGE_LENGTH,
  PREVIEW_THROTTLE_MS,
  TELEGRAM_DRAFT_ID_MAX,
} from "../constants";
import { log } from "../logger";
import { TelegramApi } from "./api";
import type { TelegramPreviewState } from "./types";

export class TelegramPreviewManager {
  private state: TelegramPreviewState | undefined;
  private draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
  private richDraftSupport: "unknown" | "supported" | "unsupported" = "unknown";
  private nextDraftId = 0;
  private typingInterval: ReturnType<typeof setInterval> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly finalizations = new WeakMap<
    TelegramPreviewState,
    Promise<boolean>
  >();

  constructor(private readonly api: TelegramApi) {}

  get hasPreview(): boolean {
    return this.state !== undefined;
  }

  get pendingText(): string | undefined {
    return this.state?.pendingText;
  }

  set pendingText(text: string) {
    this.ensureState();
    this.state!.pendingText = text;
  }

  hasVisibleText(): boolean {
    return !!(
      this.state &&
      (this.state.pendingText.trim() || this.state.lastSentText.trim())
    );
  }

  reset(replyToMessageId?: number): void {
    if (this.state?.flushTimer) clearTimeout(this.state.flushTimer);
    this.state = {
      mode: this.draftSupport === "unsupported" ? "message" : "draft",
      replyToMessageId,
      pendingText: "",
      lastSentText: "",
    };
  }

  discard(): void {
    if (this.state?.flushTimer) clearTimeout(this.state.flushTimer);
    this.state = undefined;
  }

  startTypingLoop(chatId?: number): void {
    if (this.typingInterval || chatId === undefined) return;
    const sendTyping = async () => {
      try {
        await this.api.call("sendChatAction", {
          chat_id: chatId,
          action: "typing",
        });
      } catch (e) {
        log(`typing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void sendTyping();
    this.typingInterval = setInterval(() => void sendTyping(), 4000);
  }

  stopTypingLoop(): void {
    if (this.typingInterval) clearInterval(this.typingInterval);
    this.typingInterval = undefined;
  }

  async clear(chatId: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    if (this.state === state) this.state = undefined;
    await this.enqueue(() => this.clearDraftState(chatId, state));
  }

  scheduleFlush(chatId: number): void {
    const state = this.state;
    if (!state || state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      void this.enqueue(async () => {
        if (this.state !== state) return;
        await this.flushState(chatId, state);
      });
    }, PREVIEW_THROTTLE_MS);
  }

  async finalize(chatId: number): Promise<boolean> {
    const state = this.state;
    if (!state) return false;
    const existing = this.finalizations.get(state);
    if (existing) return existing;
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = undefined;
    const finalization = this.enqueue(() => this.finalizeState(chatId, state));
    this.finalizations.set(state, finalization);
    void finalization.catch(() => {
      if (this.finalizations.get(state) === finalization)
        this.finalizations.delete(state);
    });
    return finalization;
  }

  private async finalizeState(
    chatId: number,
    state: TelegramPreviewState,
  ): Promise<boolean> {
    await this.flushState(chatId, state);
    const finalText = (state.pendingText.trim() || state.lastSentText).trim();
    if (!finalText) {
      if (this.state === state) this.state = undefined;
      return false;
    }
    if (state.mode === "draft") {
      await this.api.sendMessage(
        chatId,
        finalText,
        undefined,
        state.replyToMessageId,
      );
      if (this.state === state) this.state = undefined;
      await this.clearDraftState(chatId, state);
      return true;
    }
    if (this.state === state) this.state = undefined;
    return state.messageId !== undefined;
  }

  private ensureState(): void {
    this.state ??= {
      mode: this.draftSupport === "unsupported" ? "message" : "draft",
      pendingText: "",
      lastSentText: "",
    };
  }

  private allocateDraftId(): number {
    this.nextDraftId =
      this.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : this.nextDraftId + 1;
    return this.nextDraftId;
  }

  private async flushState(
    chatId: number,
    state: TelegramPreviewState,
  ): Promise<void> {
    const text = state.pendingText.trim();
    if (!text || text === state.lastSentText) return;
    const richTruncated =
      text.length > MAX_RICH_MESSAGE_LENGTH
        ? text.slice(0, MAX_RICH_MESSAGE_LENGTH)
        : text;
    const legacyTruncated =
      text.length > MAX_MESSAGE_LENGTH
        ? text.slice(0, MAX_MESSAGE_LENGTH)
        : text;
    if (this.richDraftSupport !== "unsupported") {
      const draftId = state.draftId ?? this.allocateDraftId();
      state.draftId = draftId;
      try {
        await this.api.sendRichMessageDraft(chatId, draftId, richTruncated);
        this.richDraftSupport = "supported";
        this.draftSupport = "supported";
        state.mode = "draft";
        state.lastSentText = richTruncated;
        return;
      } catch {
        this.richDraftSupport = "unsupported";
      }
    }
    if (this.draftSupport !== "unsupported") {
      const draftId = state.draftId ?? this.allocateDraftId();
      state.draftId = draftId;
      try {
        await this.api.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: draftId,
          text: legacyTruncated,
        });
        this.draftSupport = "supported";
        state.mode = "draft";
        state.lastSentText = legacyTruncated;
        return;
      } catch {
        this.draftSupport = "unsupported";
      }
    }
    if (state.messageId === undefined) {
      const sent = await this.api.sendMessage(
        chatId,
        richTruncated,
        undefined,
        state.replyToMessageId,
      );
      state.messageId = sent.message_id;
      state.mode = "message";
      state.lastSentText = richTruncated;
      return;
    }
    await this.api.editMessageText(chatId, state.messageId, richTruncated);
    state.mode = "message";
    state.lastSentText = richTruncated;
  }

  private async clearDraftState(
    chatId: number,
    state: TelegramPreviewState,
  ): Promise<void> {
    if (state.mode !== "draft" || state.draftId === undefined) return;
    try {
      if (this.richDraftSupport === "supported")
        await this.api.sendRichMessageDraft(chatId, state.draftId, "");
      else
        await this.api.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: state.draftId,
          text: "",
        });
    } catch {
      /* ignore */
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
