import { describe, expect, test } from "bun:test";

import { deliverPendingTelegramResponse } from "../src/telegram/response-delivery";
import type { TelegramApi } from "../src/telegram/api";
import type { TelegramPreviewManager } from "../src/telegram/preview";
import type { PendingTelegramTurn } from "../src/telegram/types";

function pendingTurn(): PendingTelegramTurn {
  return {
    id: "turn-1",
    chatId: 10,
    replyToMessageId: 20,
    queuedAttachments: [],
    content: [],
    historyText: "request",
    completedResponse: {
      text: "completed reply",
      textDelivered: false,
      queuedAttachments: [],
    },
  };
}

function asApi(api: object): TelegramApi {
  return api as TelegramApi;
}

function asPreview(preview: object): TelegramPreviewManager {
  return preview as TelegramPreviewManager;
}

describe("pending Telegram response delivery", () => {
  test("falls back to a normal reply when no preview can be finalized", async () => {
    const turn = pendingTurn();
    const replies: string[] = [];
    let saves = 0;
    const api = asApi({
      sendTextReply: async (_chatId: number, _replyTo: number, text: string) => {
        replies.push(text);
      },
    });
    const preview = asPreview({
      hasPreview: false,
      finalize: async () => false,
      clear: async () => undefined,
    });

    await deliverPendingTelegramResponse(api, preview, turn, async () => {
      saves += 1;
    });

    expect(replies).toEqual(["completed reply"]);
    expect(turn.completedResponse?.textDelivered).toBe(true);
    expect(saves).toBe(1);
  });

  test("does not duplicate a reply finalized from a live preview", async () => {
    const turn = pendingTurn();
    let normalReplies = 0;
    const previewState = { pendingText: "" };
    const preview = {
      hasPreview: true,
      get pendingText() {
        return previewState.pendingText;
      },
      set pendingText(value: string) {
        previewState.pendingText = value;
      },
      finalize: async () => true,
      clear: async () => undefined,
    };

    await deliverPendingTelegramResponse(
      asApi({
        sendTextReply: async () => {
          normalReplies += 1;
        },
      }),
      asPreview(preview),
      turn,
      async () => undefined,
    );

    expect(previewState.pendingText).toBe("completed reply");
    expect(normalReplies).toBe(0);
  });

  test("keeps a failed attachment queued for a later retry", async () => {
    const turn = pendingTurn();
    const response = turn.completedResponse;
    if (!response) throw new Error("Missing completed response in test fixture");
    response.textDelivered = true;
    response.queuedAttachments = [
      { path: "/tmp/result.txt", fileName: "result.txt" },
    ];
    let attempts = 0;
    const api = asApi({
      callMultipart: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary upload failure");
        return { message_id: 30 };
      },
    });
    const preview = asPreview({});

    let deliveryError: unknown;
    try {
      await deliverPendingTelegramResponse(
        api,
        preview,
        turn,
        async () => undefined,
      );
    } catch (error) {
      deliveryError = error;
    }
    expect(deliveryError).toBeInstanceOf(Error);
    expect((deliveryError as Error).message).toBe("temporary upload failure");
    expect(response.queuedAttachments).toHaveLength(1);

    await deliverPendingTelegramResponse(api, preview, turn, async () => undefined);
    expect(response.queuedAttachments).toHaveLength(0);
    expect(attempts).toBe(2);
  });
});
