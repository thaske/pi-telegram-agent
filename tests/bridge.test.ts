import { describe, expect, test } from "bun:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";

import { TelegramBridge } from "../src/bridge";
import { applyMessageChanges, getMessageText } from "../src/pi/session-messages";
import { telegramTurnId } from "../src/telegram/files";
import type { TelegramConfig, TelegramMessage, TelegramUpdate } from "../src/telegram/types";
import { agentHarness, pendingTurn, waitUntil } from "./helpers/durable";

function message(id: number): TelegramMessage {
  return { message_id: id, chat: { id: 10, type: "private" }, text: "request" };
}

function captureReplies(bridge: TelegramBridge): string[] {
  const replies: string[] = [];
  bridge.api.call = async <TResponse>() => true as TResponse;
  bridge.api.sendTextReply = async (_chatId, _replyTo, text) => {
    replies.push(text);
  };
  bridge.api.sendMessage = async (_chatId, text) => {
    replies.push(text);
    return { message_id: replies.length };
  };
  return replies;
}

describe("Telegram durable bridge", () => {
  test("restores the complete queue and delivers each response before starting the next turn", async () => {
    const harness = agentHarness([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    const agent = await harness.open(new MemoryStorage());
    const bridge = new TelegramBridge({}, async () => undefined, agent);
    const replies = captureReplies(bridge);
    try {
      await agent.enqueueTurn(pendingTurn("first"));
      await agent.enqueueTurn(pendingTurn("second"));
      expect(await bridge.restorePendingTurns()).toBe(true);
      await waitUntil(async () => (await agent.state.pendingTurns()).length === 0);
      expect(replies).toEqual(["first", "second"]);
      expect(harness.faux.state.callCount).toBe(2);
    } finally {
      await bridge.shutdown();
      await agent.close();
    }
  });

  test("a stored completed reply retries delivery without another model call", async () => {
    const harness = agentHarness();
    const agent = await harness.open(new MemoryStorage());
    const bridge = new TelegramBridge({}, async () => undefined, agent);
    const replies = captureReplies(bridge);
    try {
      const turn = pendingTurn();
      turn.completedResponse = { text: "already generated", textDelivered: false, queuedAttachments: [] };
      await agent.enqueueTurn(turn);
      expect(await bridge.restorePendingTurns()).toBe(true);
      expect(replies).toEqual(["already generated"]);
      expect(harness.faux.state.callCount).toBe(0);
      expect(await agent.state.pendingTurns()).toEqual([]);
    } finally {
      await bridge.shutdown();
      await agent.close();
    }
  });

  test("polling durably admits an update before advancing its offset and ignores a redelivery", async () => {
    const harness = agentHarness([fauxAssistantMessage("answer")]);
    const agent = await harness.open(new MemoryStorage());
    const config: TelegramConfig = { botToken: "test", allowedUserId: 5, lastUpdateId: 0 };
    let offsetSaves = 0;
    const bridge = new TelegramBridge(config, async (value) => {
      if (value.lastUpdateId === 1) {
        offsetSaves += 1;
        const pending = await agent.state.pendingTurns();
        expect(pending.some((turn) => turn.id === "telegram:10:1")).toBe(true);
      }
    }, agent);
    const replies = captureReplies(bridge);
    const controller = new AbortController();
    let polls = 0;
    const update: TelegramUpdate = {
      update_id: 1,
      message: { ...message(1), from: { id: 5, is_bot: false, first_name: "Test" } },
    };
    bridge.api.call = async <TResponse>(method: string, _body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      if (method !== "getUpdates") return true as TResponse;
      if (polls++ === 0) return [update, update] as TResponse;
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return [] as TResponse;
    };
    const polling = bridge.pollLoop(controller.signal);
    try {
      await waitUntil(async () => replies.includes("answer") && (await agent.state.pendingTurns()).length === 0);
      expect(offsetSaves).toBe(2);
      expect(harness.faux.state.callCount).toBe(1);
    } finally {
      controller.abort();
      await polling;
      await bridge.shutdown();
      await agent.close();
    }
  });
});

test("Telegram submission keys are stable across redelivery and album ordering", () => {
  expect(telegramTurnId([message(2), message(1)])).toBe(telegramTurnId([message(1), message(2)]));
  expect(telegramTurnId([message(1)])).not.toBe(telegramTurnId([message(2)]));
});

test("native message deltas reconstruct text without exposing thinking", () => {
  const original = fauxAssistantMessage([{ type: "thinking", thinking: "private" }, { type: "text", text: "Hello" }]);
  const partial = applyMessageChanges(structuredClone(original), [
    { type: "text_delta", contentIndex: 1, delta: " world" },
    { type: "thinking_delta", contentIndex: 0, delta: " reasoning" },
  ]);
  expect(partial && getMessageText(partial)).toBe("Hello world");
  expect(getMessageText(original)).toBe("Hello");
});
