import {
  MAX_MESSAGE_LENGTH,
  PREVIEW_THROTTLE_MS,
  TELEGRAM_DRAFT_ID_MAX,
} from "../constants.js";
import { log } from "../logger.js";
import { TelegramApi } from "./api.js";
import type { TelegramPreviewState, TelegramSentMessage } from "./types.js";

export class TelegramPreviewManager {
  private state: TelegramPreviewState | undefined;
  private draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
  private nextDraftId = 0;
  private typingInterval: ReturnType<typeof setInterval> | undefined;

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

  reset(): void {
    this.state = {
      mode: this.draftSupport === "unsupported" ? "message" : "draft",
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
    this.state = undefined;
    if (state.mode === "draft" && state.draftId !== undefined) {
      try {
        await this.api.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: state.draftId,
          text: "",
        });
      } catch {
        /* ignore */
      }
    }
  }

  scheduleFlush(chatId: number): void {
    if (!this.state || this.state.flushTimer) return;
    this.state.flushTimer = setTimeout(
      () => void this.flush(chatId),
      PREVIEW_THROTTLE_MS,
    );
  }

  async finalize(chatId: number): Promise<boolean> {
    const state = this.state;
    if (!state) return false;
    await this.flush(chatId);
    const finalText = (state.pendingText.trim() || state.lastSentText).trim();
    if (!finalText) {
      await this.clear(chatId);
      return false;
    }
    if (state.mode === "draft") {
      await this.api.sendMessage(chatId, finalText);
      await this.clear(chatId);
      return true;
    }
    this.state = undefined;
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

  private async flush(chatId: number): Promise<void> {
    const state = this.state;
    if (!state) return;
    state.flushTimer = undefined;
    const text = state.pendingText.trim();
    if (!text || text === state.lastSentText) return;
    const truncated =
      text.length > MAX_MESSAGE_LENGTH
        ? text.slice(0, MAX_MESSAGE_LENGTH)
        : text;
    if (this.draftSupport !== "unsupported") {
      const draftId = state.draftId ?? this.allocateDraftId();
      state.draftId = draftId;
      try {
        await this.api.call("sendMessageDraft", {
          chat_id: chatId,
          draft_id: draftId,
          text: truncated,
        });
        this.draftSupport = "supported";
        state.mode = "draft";
        state.lastSentText = truncated;
        return;
      } catch {
        this.draftSupport = "unsupported";
      }
    }
    if (state.messageId === undefined) {
      const sent = await this.api.sendMessage(chatId, truncated);
      state.messageId = sent.message_id;
      state.mode = "message";
      state.lastSentText = truncated;
      return;
    }
    await this.api.editMessageText(chatId, state.messageId, truncated);
    state.mode = "message";
    state.lastSentText = truncated;
  }
}
