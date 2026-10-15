import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";

import type { PendingTelegramTurn, TelegramMessage } from "../telegram/types";

export const TelegramState = defineDoc<{
  conversationId?: ConversationId;
  turns: JsonRepresentation<PendingTelegramTurn>[];
  completedTurnIds: string[];
  mediaGroups: Record<string, JsonRepresentation<TelegramMessage>[]>;
}>({
  kind: "telegram.state",
  version: 1,
  scope: "session",
  initial: () => ({ turns: [], completedTurnIds: [], mediaGroups: {} }),
});

// Strip optional undefined properties before handing values to Chord's JSON documents.
export function toJson<T>(value: T): JsonRepresentation<T> {
  return JSON.parse(JSON.stringify(value)) as JsonRepresentation<T>;
}

export function mediaGroupKey(message: TelegramMessage): string {
  return `${message.chat.id}:${message.media_group_id}`;
}

export class DurableTelegramState {
  constructor(private readonly harness: Harness) {}

  async pendingTurns(): Promise<PendingTelegramTurn[]> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return structuredClone(state?.turns ?? []);
  }

  async enqueue(turn: PendingTelegramTurn, mediaMessages: TelegramMessage[] = []): Promise<boolean> {
    const value = toJson(turn);
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const first = mediaMessages[0];
      if (first?.media_group_id) {
        const ids = new Set(mediaMessages.map((message) => message.message_id));
        const key = mediaGroupKey(first);
        const remaining = state.mediaGroups[key]?.filter((message) => !ids.has(message.message_id)) ?? [];
        if (remaining.length) state.mediaGroups[key] = remaining;
        else delete state.mediaGroups[key];
      }
      if (
        state.turns.some((pending) => pending.id === turn.id) ||
        state.completedTurnIds.includes(turn.id)
      ) return false;
      state.turns.push(value);
      return true;
    }, BACKGROUND_CONTEXT);
  }

  async save(turn: PendingTelegramTurn): Promise<void> {
    const value = toJson(turn);
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const index = state.turns.findIndex((pending) => pending.id === turn.id);
      if (index < 0) throw new Error(`Unknown Telegram turn ${turn.id}`);
      state.turns[index] = value;
    }, BACKGROUND_CONTEXT);
  }

  async complete(turnId: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      if (state.completedTurnIds.includes(turnId)) return;
      if (state.turns[0]?.id !== turnId)
        throw new Error(`Telegram turn ${turnId} does not own delivery state`);
      state.turns.shift();
      state.completedTurnIds.push(turnId);
      // Telegram's update offset is the long-term receipt; retain a bounded overlap.
      if (state.completedTurnIds.length > 1000) state.completedTurnIds.shift();
    }, BACKGROUND_CONTEXT);
  }

  async bufferMedia(message: TelegramMessage): Promise<void> {
    const value = toJson(message);
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const key = mediaGroupKey(message);
      if (!state.mediaGroups[key]) state.mediaGroups[key] = [];
      const messages = state.mediaGroups[key];
      if (!messages.some((item) => item.message_id === message.message_id)) messages.push(value);
    }, BACKGROUND_CONTEXT);
  }

  async bufferedMedia(): Promise<TelegramMessage[]> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return structuredClone(Object.values(state?.mediaGroups ?? {}).flat());
  }

  async completeMedia(messages: TelegramMessage[]): Promise<void> {
    const first = messages[0];
    if (!first?.media_group_id) return;
    const ids = new Set(messages.map((message) => message.message_id));
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const key = mediaGroupKey(first);
      const remaining = state.mediaGroups[key]?.filter((message) => !ids.has(message.message_id)) ?? [];
      if (remaining.length) state.mediaGroups[key] = remaining;
      else delete state.mediaGroups[key];
    }, BACKGROUND_CONTEXT);
  }
}
