import { describe, expect, test } from "bun:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import type { TelegramApi } from "../src/telegram/api";
import { TelegramCommandHandler } from "../src/telegram/commands";
import type { TelegramModelPicker } from "../src/telegram/model-picker";
import type { TelegramMessage } from "../src/telegram/types";

const commandMessage: TelegramMessage = {
  message_id: 5,
  chat: { id: 10, type: "private" },
  text: "/new",
};

describe("Telegram command lifecycle guard", () => {
  test("does not allow /new to discard a turn awaiting delivery", async () => {
    const replies: string[] = [];
    let sessionsStarted = 0;
    let queuesCleared = 0;
    const handler = new TelegramCommandHandler(
      {
        sendTextReply: async (_chatId: number, _replyTo: number, text: string) => {
          replies.push(text);
        },
      } as TelegramApi,
      {
        hasPendingSearch: () => false,
      } as unknown as TelegramModelPicker,
      {
        bindSession: async () => undefined,
        clearQueuedTurns: () => {
          queuesCleared += 1;
        },
        discardPreview: () => undefined,
        getQueueLength: () => 0,
        hasPendingTurn: () => true,
        getSession: () => ({ isStreaming: false }) as AgentSession,
        newSession: async () => {
          sessionsStarted += 1;
          return { cancelled: false };
        },
        preserveQueuedTurnsAsHistory: () => undefined,
      },
    );

    expect(await handler.handle([commandMessage])).toBe(true);
    expect(replies).toEqual([
      "Cannot start a new chat while the previous response is still being delivered. Try again shortly.",
    ]);
    expect(sessionsStarted).toBe(0);
    expect(queuesCleared).toBe(0);
  });
});
