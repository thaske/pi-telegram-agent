import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { TelegramBridge } from "../src/bridge";
import { TelegramState } from "../src/pi/durable-state";
import { TelegramApiError } from "../src/telegram/api";
import { agentHarness, pendingTurn, waitUntil } from "./helpers/durable";
import { authorizedMessage, pollUpdates, telegramApiHarness } from "./helpers/telegram";

test("a permanently invalid file is durably rejected without blocking the following input", async () => {
  const harness = agentHarness([fauxAssistantMessage("valid answer")]);
  const agent = await harness.open(new MemoryStorage());
  const config = { botToken: "offline", allowedUserId: 5, lastUpdateId: 0 };
  const bridge = new TelegramBridge(config, async () => {}, agent);
  const telegram = telegramApiHarness();
  bridge.api.call = telegram.api.call.bind(telegram.api);
  bridge.api.downloadFile = async () => { throw new TelegramApiError(400, "file is too big", "getFile"); };
  const polling = pollUpdates(bridge, [
    { update_id: 1, message: { ...authorizedMessage(1), document: { file_id: "big", file_name: "big.bin" } } },
    { update_id: 2, message: authorizedMessage(2) },
  ]);
  try {
    await waitUntil(async () => config.lastUpdateId === 2 && (await agent.state.pendingTurns()).length === 0);
    expect([...telegram.messages.values()]).toEqual([
      "Could not read this Telegram attachment: file is too big", "valid answer",
    ]);
    expect(harness.faux.state.callCount).toBe(1);
    expect(await agent.state.unprocessedMessages([authorizedMessage(1), authorizedMessage(2)])).toEqual([]);
  } finally { await polling.stop(); await bridge.shutdown(); await agent.close(); }
});

test("transient preparation failures do not acknowledge or reject an input, and polling is cancellable", async () => {
  const agent = await agentHarness().open(new MemoryStorage());
  const config = { botToken: "offline", allowedUserId: 5, lastUpdateId: 0 };
  const bridge = new TelegramBridge(config, async () => {}, agent);
  const telegram = telegramApiHarness();
  bridge.api.call = telegram.api.call.bind(telegram.api);
  let downloads = 0;
  bridge.api.downloadFile = async () => { downloads++; throw new TelegramApiError(503, "offline", "getFile"); };
  const polling = pollUpdates(bridge, [
    { update_id: 1, message: { ...authorizedMessage(1), document: { file_id: "file" } } },
  ]);
  try {
    await waitUntil(() => downloads === 1);
    expect(config.lastUpdateId).toBe(0);
    expect(await agent.state.pendingTurns()).toEqual([]);
    expect(await agent.state.unprocessedMessages([authorizedMessage(1)])).toHaveLength(1);
  } finally { await polling.stop(); await bridge.shutdown(); await agent.close(); }
});

test("an unavailable authorization notification does not block the authorized user", async () => {
  const harness = agentHarness([fauxAssistantMessage("authorized answer")]);
  const agent = await harness.open(new MemoryStorage());
  const config = { botToken: "offline", allowedUserId: 5, lastUpdateId: 0 };
  const bridge = new TelegramBridge(config, async () => {}, agent);
  const telegram = telegramApiHarness();
  bridge.api.call = telegram.api.call.bind(telegram.api);
  bridge.api.sendTextReply = async () => { throw new TelegramApiError(403, "bot was blocked", "sendMessage"); };
  const polling = pollUpdates(bridge, [
    { update_id: 1, message: { ...authorizedMessage(1), from: { id: 99, is_bot: false, first_name: "Other" } } },
    { update_id: 2, message: authorizedMessage(2) },
  ]);
  try {
    await waitUntil(async () => config.lastUpdateId === 2 && (await agent.state.pendingTurns()).length === 0);
    expect([...telegram.messages.values()]).toEqual(["authorized answer"]);
    expect(harness.faux.state.callCount).toBe(1);
  } finally { await polling.stop(); await bridge.shutdown(); await agent.close(); }
});

test("SQLite reopen ignores a redelivered album subset but admits genuinely new late members", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-album-receipts-"));
  const database = join(dir, "state.sqlite");
  const harness = agentHarness([fauxAssistantMessage("whole album"), fauxAssistantMessage("new member")]);
  let agent = await harness.open(await openNodeSqliteStorage(database));
  let bridge = new TelegramBridge({}, async () => {}, agent);
  let polling: ReturnType<typeof pollUpdates> | undefined;
  const telegram = telegramApiHarness();
  const downloads: string[] = [];
  const album = [1, 2, 3].map((id) => ({
    ...authorizedMessage(id, ""), media_group_id: "album",
    document: { file_id: `file-${id}`, file_name: `${id}.txt`, mime_type: "text/plain" },
  }));
  const connect = () => {
    bridge.api.call = telegram.api.call.bind(telegram.api);
    bridge.api.downloadFile = async (id) => { downloads.push(id); return "/tmp/offline-document.txt"; };
  };
  try {
    connect();
    for (const message of album.slice(0, 2)) await agent.state.bufferMedia(message);
    await bridge.restorePendingTurns();
    await waitUntil(async () => harness.faux.state.callCount === 1 && (await agent.state.pendingTurns()).length === 0);
    await bridge.shutdown();
    await agent.close();
    agent = await harness.open(await openNodeSqliteStorage(database));
    const config = { botToken: "offline", allowedUserId: 5, lastUpdateId: 1 };
    bridge = new TelegramBridge(config, async () => {}, agent);
    connect();
    await bridge.restorePendingTurns();
    polling = pollUpdates(bridge, [{ update_id: 2, message: album[1] }, { update_id: 3, message: album[2] }]);
    await waitUntil(async () => harness.faux.state.callCount === 2 && (await agent.state.pendingTurns()).length === 0);
    expect(downloads).toEqual(["file-1", "file-2", "file-3"]);
    expect([...telegram.messages.values()]).toEqual(["whole album", "new member"]);
    expect(await agent.state.bufferedMedia()).toEqual([]);
  } finally {
    await polling?.stop(); await bridge.shutdown(); await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-receipt databases recover message identities from retained album turn IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-receipt-upgrade-"));
  const database = join(dir, "state.sqlite");
  const harness = agentHarness();
  let agent = await harness.open(await openNodeSqliteStorage(database));
  try {
    await agent.harness.commit(async (tx) => {
      const state = await tx.doc(TelegramState);
      delete state.messageReceipts;
      state.completedTurnIds.push("telegram:10:1,2");
    }, BACKGROUND_CONTEXT);
    await agent.close();
    agent = await harness.open(await openNodeSqliteStorage(database));
    expect(await agent.state.unprocessedMessages([authorizedMessage(1), authorizedMessage(2), authorizedMessage(3)]))
      .toEqual([authorizedMessage(3)]);
    expect(await agent.state.bufferMedia({ ...authorizedMessage(2), media_group_id: "album" })).toBe(false);
  } finally { await agent.close(); await rm(dir, { recursive: true, force: true }); }
});

test("reopened completed replies remove persisted fallback previews before final delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-preview-recovery-"));
  const database = join(dir, "state.sqlite");
  const harness = agentHarness();
  let agent = await harness.open(await openNodeSqliteStorage(database));
  let bridge: TelegramBridge | undefined;
  const telegram = telegramApiHarness();
  telegram.messages.set(77, "unfinished preview");
  try {
    const turn = pendingTurn();
    turn.completedResponse = { text: "authoritative answer", textDelivered: false, queuedAttachments: [] };
    await agent.enqueueTurn(turn);
    await agent.state.recordPreview(turn.id, 77);
    await agent.close();
    agent = await harness.open(await openNodeSqliteStorage(database));
    bridge = new TelegramBridge({}, async () => {}, agent);
    bridge.api.call = telegram.api.call.bind(telegram.api);
    await bridge.restorePendingTurns();
    expect([...telegram.messages.values()]).toEqual(["authoritative answer"]);
    expect(telegram.calls.some((call) => call.method === "deleteMessage" && call.body.message_id === 77)).toBe(true);
  } finally { await bridge?.shutdown(); await agent.close(); await rm(dir, { recursive: true, force: true }); }
});
