import { rejects } from "node:assert/strict";

import { describe, expect, test } from "bun:test";

import { TelegramPreviewManager } from "../src/telegram/preview";
import { waitUntil } from "./helpers/durable";
import { telegramApiHarness } from "./helpers/telegram";

describe("ephemeral Telegram previews", () => {
  test("legacy previews stay in one message and clear removes it", async () => {
    const { api, calls, messages } = telegramApiHarness();
    const preview = new TelegramPreviewManager(api);
    preview.reset(1);
    preview.pendingText = "a".repeat(5000);
    preview.scheduleFlush(10);
    await waitUntil(() => messages.size === 1);
    preview.pendingText = "b".repeat(5100);
    preview.scheduleFlush(10);
    await waitUntil(() => [...messages.values()][0] === "b".repeat(4096));
    expect(messages.size).toBe(1);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    await preview.clear(10);
    expect(messages.size).toBe(0);
  });

  test("clear joins an in-flight send without clearing a newly reset preview", async () => {
    const { api, messages } = telegramApiHarness();
    const gate = Promise.withResolvers<void>();
    const send = api.sendMessage.bind(api);
    let sending = false;
    api.sendMessage = async (...args) => { sending = true; await gate.promise; return send(...args); };
    const preview = new TelegramPreviewManager(api);
    preview.reset(1);
    preview.pendingText = "old";
    preview.scheduleFlush(10);
    await waitUntil(() => sending);
    const clearing = preview.clear(10);
    preview.reset(2);
    preview.pendingText = "new";
    gate.resolve();
    await clearing;
    expect(messages.size).toBe(0);
    expect(preview.pendingText).toBe("new");
    preview.scheduleFlush(10);
    await waitUntil(() => messages.size === 1);
    expect([...messages.values()]).toEqual(["new"]);
    await preview.clear(10);
  });

  test("a transient cleanup error remains retryable", async () => {
    const { api, messages } = telegramApiHarness();
    const preview = new TelegramPreviewManager(api);
    preview.pendingText = "unfinished";
    preview.scheduleFlush(10);
    await waitUntil(() => messages.size === 1);
    const remove = api.deleteMessage.bind(api);
    api.deleteMessage = async () => { throw new Error("offline"); };
    await rejects(preview.clear(10), /offline/);
    api.deleteMessage = remove;
    await preview.clear(10);
    expect(messages.size).toBe(0);
  });

  test("clears drafts without turning preview text into a final send", async () => {
    const { api, calls, messages } = telegramApiHarness({ rich: true, drafts: true });
    const preview = new TelegramPreviewManager(api);
    preview.pendingText = "temporary";
    preview.scheduleFlush(10);
    await waitUntil(() => calls.some((call) => call.method === "sendRichMessageDraft"));
    await preview.clear(10);
    expect(messages.size).toBe(0);
    expect(calls.at(-1)?.body.rich_message).toEqual({ markdown: "" });
  });
});
