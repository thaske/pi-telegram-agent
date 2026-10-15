import { TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS } from "../constants";
import { log } from "../logger";
import type { TelegramMediaGroupState, TelegramMessage } from "./types";

export class TelegramMediaGroupBuffer {
  private readonly mediaGroups = new Map<string, TelegramMediaGroupState>();
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;

  constructor(private readonly dispatch: (messages: TelegramMessage[]) => Promise<void>) {}

  get hasPending(): boolean {
    return this.mediaGroups.size > 0;
  }

  handle(message: TelegramMessage): boolean {
    if (!message.media_group_id || this.stopping) return false;
    const key = `${message.chat.id}:${message.media_group_id}`;
    const state = this.mediaGroups.get(key) ?? { messages: [] };
    if (!state.messages.some((item) => item.message_id === message.message_id)) state.messages.push(message);
    this.schedule(key, state);
    this.mediaGroups.set(key, state);
    return true;
  }

  async discard(): Promise<void> {
    this.stopping = true;
    for (const state of this.mediaGroups.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    this.mediaGroups.clear();
    await Promise.allSettled(this.inFlight);
  }

  private schedule(key: string, state: TelegramMediaGroupState): void {
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      const work = this.flush(key, state).finally(() => this.inFlight.delete(work));
      this.inFlight.add(work);
    }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
  }

  private async flush(key: string, state: TelegramMediaGroupState): Promise<void> {
    if (state.flushing || this.stopping) return;
    state.flushing = true;
    const messages = [...state.messages];
    try {
      await this.dispatch(messages);
      const ids = new Set(messages.map((message) => message.message_id));
      state.messages = state.messages.filter((message) => !ids.has(message.message_id));
    } catch (error) {
      log(`media group delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.flushing = false;
      if (!this.stopping && state.messages.length) this.schedule(key, state);
      else {
        if (state.flushTimer) clearTimeout(state.flushTimer);
        this.mediaGroups.delete(key);
      }
    }
  }
}
