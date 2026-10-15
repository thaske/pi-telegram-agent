import type { Draft, JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";

import { telegramMessageKey, turnMessageKeys } from "../telegram/identity";
import type { PendingTelegramTurn, TelegramCommandReceipt, TelegramMessage } from "../telegram/types";

export type TelegramStateData = {
  conversationId?: ConversationId;
  turns: JsonRepresentation<PendingTelegramTurn>[];
  completedTurnIds: string[];
  mediaGroups: Record<string, JsonRepresentation<TelegramMessage>[]>;
  messageReceipts?: Record<string, boolean>;
  commands?: Record<string, TelegramCommandReceipt>;
};

export const TelegramState = defineDoc<TelegramStateData>({
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

export function initializeReceipts(state: Draft<TelegramStateData>): void {
  if (state.messageReceipts) return;
  state.messageReceipts = {};
  for (const id of [...state.completedTurnIds, ...state.turns.map((turn) => turn.id)])
    for (const key of turnMessageKeys(id)) state.messageReceipts[key] = true;
}

function removeBufferedMedia(state: Draft<TelegramStateData>, messages: TelegramMessage[]): void {
  const first = messages[0];
  if (!first?.media_group_id) return;
  const ids = new Set(messages.map((message) => message.message_id));
  const key = mediaGroupKey(first);
  const remaining = state.mediaGroups[key]?.filter((message) => !ids.has(message.message_id)) ?? [];
  if (remaining.length) state.mediaGroups[key] = remaining;
  else delete state.mediaGroups[key];
}

export class DurableTelegramState {
  constructor(private readonly harness: Harness) {}

  async pendingTurns(): Promise<PendingTelegramTurn[]> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return structuredClone(state?.turns ?? []);
  }

  async unprocessedMessages(messages: TelegramMessage[]): Promise<TelegramMessage[]> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return messages.filter((message) => !state?.messageReceipts?.[telegramMessageKey(message)]);
  }

  async enqueue(turn: PendingTelegramTurn, mediaMessages: TelegramMessage[] = []): Promise<boolean> {
    const value = toJson(turn);
    const keys = mediaMessages.length ? mediaMessages.map(telegramMessageKey) : turnMessageKeys(turn.id);
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      initializeReceipts(state);
      const received = keys.filter((key) => state.messageReceipts![key]).length;
      if (received > 0 && received < keys.length)
        throw new Error("Telegram admission changed while preparing this batch; retry unprocessed messages");
      if ((keys.length > 0 && received === keys.length) ||
          state.turns.some((pending) => pending.id === turn.id) || state.completedTurnIds.includes(turn.id)) {
        removeBufferedMedia(state, mediaMessages);
        return false;
      }
      state.turns.push(value);
      for (const key of keys) state.messageReceipts![key] = true;
      removeBufferedMedia(state, mediaMessages);
      return true;
    }, BACKGROUND_CONTEXT);
  }

  async wasStopped(turnId: string): Promise<boolean> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return Object.values(state?.commands ?? {}).some((receipt) => receipt.kind === "stop" && receipt.turnId === turnId);
  }

  async command(requestId: string): Promise<TelegramCommandReceipt | undefined> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return structuredClone(state?.commands?.[requestId]);
  }

  async pendingCompactions() {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return Object.entries(state?.commands ?? {}).flatMap(([requestId, receipt]) =>
      receipt.kind === "compact" && !receipt.replyQueued ? [{ requestId, receipt: structuredClone(receipt) }] : [],
    );
  }

  async queueCompactionReply(requestId: string, text: string): Promise<PendingTelegramTurn | undefined> {
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      const receipt = state.commands?.[requestId];
      if (receipt?.kind !== "compact" || receipt.replyQueued) return undefined;
      const turn: PendingTelegramTurn = {
        id: `command:${requestId}`, chatId: receipt.chatId, replyToMessageId: receipt.replyToMessageId,
        conversationId: state.conversationId, content: [], historyText: "/compact", queuedAttachments: [],
        completedResponse: { text, textDelivered: false, queuedAttachments: [] },
      };
      state.turns.push(toJson(turn));
      receipt.replyQueued = true;
      return turn;
    }, BACKGROUND_CONTEXT);
  }

  async recordPreview(turnId: string, messageId: number): Promise<void> {
    await this.harness.commit(async (tx) => {
      const turn = (await tx.doc(TelegramState)).turns.find((pending) => pending.id === turnId);
      if (!turn) throw new Error(`Unknown Telegram turn ${turnId}`);
      turn.previewMessageIds ??= [];
      if (!turn.previewMessageIds.includes(messageId)) turn.previewMessageIds.push(messageId);
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
      // Individual input receipts are retained separately; bound the legacy/delivery overlap.
      if (state.completedTurnIds.length > 1000) state.completedTurnIds.shift();
    }, BACKGROUND_CONTEXT);
  }

  async bufferMedia(message: TelegramMessage): Promise<boolean> {
    const value = toJson(message);
    return this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      if (state.messageReceipts?.[telegramMessageKey(message)]) return false;
      const key = mediaGroupKey(message);
      if (!state.mediaGroups[key]) state.mediaGroups[key] = [];
      const messages = state.mediaGroups[key];
      if (!messages.some((item) => item.message_id === message.message_id)) messages.push(value);
      return true;
    }, BACKGROUND_CONTEXT);
  }

  async bufferedMedia(): Promise<TelegramMessage[]> {
    const state = await this.harness.snapshot(TelegramState, BACKGROUND_CONTEXT);
    return structuredClone(Object.values(state?.mediaGroups ?? {}).flat());
  }

  async completeMedia(messages: TelegramMessage[]): Promise<void> {
    await this.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      initializeReceipts(state);
      for (const message of messages) state.messageReceipts![telegramMessageKey(message)] = true;
      removeBufferedMedia(state, messages);
    }, BACKGROUND_CONTEXT);
  }
}
