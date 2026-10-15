import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { TelegramPreviewManager } from "../src/telegram/preview";
import { deliverPendingTelegramResponse } from "../src/telegram/response-delivery";
import { agentHarness, pendingTurn, waitUntil } from "./helpers/durable";
import { telegramApiHarness } from "./helpers/telegram";

function completedTurn(text = "completed reply") {
  const turn = pendingTurn();
  turn.completedResponse = { text, textDelivered: false, queuedAttachments: [] };
  return turn;
}

describe("physical Telegram response receipts", () => {
  test("freezes the legacy fallback plan before sending and receipts each message", async () => {
    const { api, messages } = telegramApiHarness();
    const turn = completedTurn("a".repeat(5000));
    let saves = 0;
    await deliverPendingTelegramResponse(api, new TelegramPreviewManager(api), turn, async () => { saves++; });
    expect([...messages.values()].map((text) => text.length)).toEqual([4096, 904]);
    expect(turn.completedResponse?.textChunks?.map((chunk) => chunk.mode)).toEqual(["legacy", "legacy"]);
    expect(turn.completedResponse?.sentTextChunks).toBe(2);
    expect(turn.completedResponse?.textDelivered).toBe(true);
    expect(saves).toBe(5); // plan, fallback plan, two receipts, final completion
  });

  test("removes a live fallback preview before delivering the complete response", async () => {
    const { api, messages } = telegramApiHarness();
    const preview = new TelegramPreviewManager(api);
    preview.reset(20);
    preview.pendingText = "a".repeat(5000);
    preview.scheduleFlush(10);
    await waitUntil(() => messages.size === 1);
    const text = "a".repeat(5000) + "z".repeat(100);
    await deliverPendingTelegramResponse(api, preview, completedTurn(text), async () => {});
    expect([...messages.values()].join("")).toBe(text);
    expect(messages.size).toBe(2);
  });

  test("SQLite reopen retries only the failed chunk, not the acknowledged prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-outbox-"));
    const database = join(dir, "state.sqlite");
    const harness = agentHarness();
    const { api, messages, failedSends } = telegramApiHarness();
    failedSends.add(2);
    let agent = await harness.open(await openNodeSqliteStorage(database));
    try {
      const turn = completedTurn("a".repeat(5000));
      await agent.enqueueTurn(turn);
      await rejects(deliverPendingTelegramResponse(api, new TelegramPreviewManager(api), turn, () => agent.state.save(turn)), /Temporary failure/);
      expect(turn.completedResponse?.sentTextChunks).toBe(1);
      expect([...messages.values()].map((text) => text.length)).toEqual([4096]);
      await agent.close();
      agent = await harness.open(await openNodeSqliteStorage(database));
      const restored = (await agent.state.pendingTurns())[0];
      failedSends.clear();
      await deliverPendingTelegramResponse(api, new TelegramPreviewManager(api), restored, () => agent.state.save(restored));
      expect([...messages.values()].join("")).toBe("a".repeat(5000));
      expect([...messages.values()].map((text) => text.length)).toEqual([4096, 904]);
      expect(harness.faux.state.callCount).toBe(0);
    } finally {
      await agent.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a failed attachment queued for a later retry", async () => {
    const { api } = telegramApiHarness();
    const turn = completedTurn();
    const response = turn.completedResponse!;
    response.textDelivered = true;
    response.queuedAttachments = [{ path: "/tmp/result.txt", fileName: "result.txt" }];
    let attempts = 0;
    api.callMultipart = async <T>() => {
      if (++attempts === 1) throw new Error("temporary upload failure");
      return { message_id: 30 } as T;
    };
    const preview = new TelegramPreviewManager(api);
    await rejects(deliverPendingTelegramResponse(api, preview, turn, async () => {}), /temporary upload failure/);
    expect(response.queuedAttachments).toHaveLength(1);
    await deliverPendingTelegramResponse(api, preview, turn, async () => {});
    expect(response.queuedAttachments).toHaveLength(0);
    expect(attempts).toBe(2);
  });
});
