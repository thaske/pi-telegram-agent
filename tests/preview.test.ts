import { describe, expect, test } from "bun:test";

import type { TelegramApi } from "../src/telegram/api";
import { TelegramPreviewManager } from "../src/telegram/preview";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Telegram preview generations", () => {
  test("concurrent finalization calls share one Telegram send", async () => {
    let sends = 0;
    const api = {
      sendRichMessageDraft: async () => undefined,
      call: async () => true,
      sendMessage: async () => {
        sends += 1;
        return { message_id: sends };
      },
      editMessageText: async () => undefined,
    } as unknown as TelegramApi;
    const preview = new TelegramPreviewManager(api);
    preview.reset(1);
    preview.pendingText = "one response";

    const first = preview.finalize(10);
    const second = preview.finalize(10);

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(sends).toBe(1);
  });

  test("an old finalization cannot clear a newly reset preview", async () => {
    const firstDraft = deferred();
    let draftCalls = 0;
    const sentReplies: string[] = [];
    const api = {
      sendRichMessageDraft: async () => {
        draftCalls += 1;
        if (draftCalls === 1) await firstDraft.promise;
      },
      call: async () => true,
      sendMessage: async (
        _chatId: number,
        text: string,
      ) => {
        sentReplies.push(text);
        return { message_id: sentReplies.length };
      },
      editMessageText: async () => undefined,
    } as unknown as TelegramApi;
    const preview = new TelegramPreviewManager(api);

    preview.reset(1);
    preview.pendingText = "old response";
    const oldFinalization = preview.finalize(10);
    preview.reset(2);
    preview.pendingText = "new response";

    firstDraft.resolve();
    expect(await oldFinalization).toBe(true);
    expect(preview.hasPreview).toBe(true);
    expect(preview.pendingText).toBe("new response");

    expect(await preview.finalize(10)).toBe(true);
    expect(sentReplies).toEqual(["old response", "new response"]);
  });
});
