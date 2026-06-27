import { TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS } from "../constants";
import type { TelegramMediaGroupState, TelegramMessage } from "./types";

export class TelegramMediaGroupBuffer {
  private readonly mediaGroups = new Map<string, TelegramMediaGroupState>();

  constructor(
    private readonly dispatch: (messages: TelegramMessage[]) => Promise<void>,
  ) {}

  handle(message: TelegramMessage): boolean {
    if (!message.media_group_id) return false;

    const key = `${message.chat.id}:${message.media_group_id}`;
    const existing = this.mediaGroups.get(key) ?? { messages: [] };
    existing.messages.push(message);
    if (existing.flushTimer) clearTimeout(existing.flushTimer);
    existing.flushTimer = setTimeout(() => {
      const state = this.mediaGroups.get(key);
      this.mediaGroups.delete(key);
      if (state) void this.dispatch(state.messages);
    }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
    this.mediaGroups.set(key, existing);
    return true;
  }

  discard(): void {
    for (const state of this.mediaGroups.values())
      if (state.flushTimer) clearTimeout(state.flushTimer);
    this.mediaGroups.clear();
  }
}
