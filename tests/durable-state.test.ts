import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { migratePendingTurn, readPendingTurn } from "../src/pending-turn";
import type { TelegramMessage } from "../src/telegram/types";
import { agentHarness, pendingTurn } from "./helpers/durable";

async function failureMessage(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
}

test("queue order, partial delivery receipts, and buffered albums survive SQLite reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-state-"));
  const database = join(dir, "state.sqlite");
  const harness = agentHarness();
  let agent = await harness.open(await openNodeSqliteStorage(database));
  try {
    const first = pendingTurn("first");
    first.completedResponse = {
      text: "sent already",
      textDelivered: true,
      queuedAttachments: [{ path: "/tmp/remaining.txt", fileName: "remaining.txt" }],
    };
    await agent.enqueueTurn(first);
    await agent.enqueueTurn(pendingTurn("second"));
    const photo: TelegramMessage = {
      message_id: 3,
      chat: { id: 10, type: "private" },
      media_group_id: "album",
      photo: [{ file_id: "photo" }],
    };
    await agent.state.bufferMedia(photo);
    await agent.state.bufferMedia(photo);
    expect(await agent.state.bufferedMedia()).toEqual([photo]);
    await agent.close();

    agent = await harness.open(await openNodeSqliteStorage(database));
    expect((await agent.state.pendingTurns()).map((turn) => turn.id)).toEqual(["first", "second"]);
    expect((await agent.state.pendingTurns())[0].completedResponse).toEqual(first.completedResponse);
    expect(await failureMessage(agent.state.complete("second"))).toContain("does not own delivery state");
    expect(await agent.state.bufferedMedia()).toEqual([photo]);
    const album = pendingTurn("album-turn");
    await agent.enqueueTurn(album, [photo]);
    expect(await agent.state.bufferedMedia()).toEqual([]);
    expect((await agent.state.pendingTurns()).map((turn) => turn.id)).toEqual(["first", "second", "album-turn"]);
  } finally {
    await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy journal import is retryable and removes the file only after durable admission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-legacy-"));
  const journal = join(dir, "pending-turn.json");
  const harness = agentHarness();
  const agent = await harness.open(new MemoryStorage());
  try {
    const turn = pendingTurn();
    const serialized = JSON.stringify({ ...turn, id: undefined });
    await writeFile(journal, serialized);
    const legacy = await readPendingTurn(journal);
    if (!legacy) throw new Error("Legacy journal was not read");
    const id = legacy.id;
    expect(id).toStartWith("legacy-");
    expect(await failureMessage(migratePendingTurn(async () => { throw new Error("admission failed"); }, journal))).toBe("admission failed");
    expect(await readFile(journal, "utf-8")).toBe(serialized);
    expect(await migratePendingTurn((value) => agent.enqueueTurn(value), journal)).toBe(true);
    expect(await readPendingTurn(journal)).toBeUndefined();
    expect((await agent.state.pendingTurns()).map((value) => value.id)).toEqual([id]);
    // Simulate a crash after admission but before unlinking the old journal.
    await writeFile(journal, serialized);
    await migratePendingTurn((value) => agent.enqueueTurn(value), journal);
    expect((await agent.state.pendingTurns()).length).toBe(1);
    expect(await readPendingTurn(journal)).toBeUndefined();
  } finally {
    await agent.close();
    await rm(dir, { recursive: true, force: true });
  }
});
