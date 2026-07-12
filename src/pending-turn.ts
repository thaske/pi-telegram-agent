import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PENDING_TURN_PATH } from "./constants";
import type { PendingTelegramTurn } from "./telegram/types";

let journalQueue: Promise<void> = Promise.resolve();

export function readPendingTurn(): Promise<PendingTelegramTurn | undefined> {
  return enqueueJournalOperation(readPendingTurnFile);
}

export function writePendingTurn(turn: PendingTelegramTurn): Promise<void> {
  const serialized = JSON.stringify(turn);
  return enqueueJournalOperation(() => writePendingTurnFile(serialized));
}

export function removePendingTurn(expectedTurnId: string): Promise<boolean> {
  return enqueueJournalOperation(async () => {
    const pending = await readPendingTurnFile();
    if (!pending) return false;
    if (pending.id !== expectedTurnId)
      throw new Error(
        `Refusing to remove pending Telegram turn ${pending.id}; expected ${expectedTurnId}`,
      );
    try {
      await unlink(PENDING_TURN_PATH);
      return true;
    } catch (error) {
      if (isFileNotFound(error)) return false;
      throw error;
    }
  });
}

async function readPendingTurnFile(): Promise<PendingTelegramTurn | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(PENDING_TURN_PATH, "utf-8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }

  const turn = JSON.parse(serialized) as PendingTelegramTurn;
  // Pending records written before turn IDs were introduced remain recoverable.
  turn.id ||=
    `legacy-${createHash("sha256").update(serialized).digest("hex")}`;
  return turn;
}

async function writePendingTurnFile(serialized: string): Promise<void> {
  await mkdir(dirname(PENDING_TURN_PATH), { recursive: true });
  const temporaryPath = `${PENDING_TURN_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, "utf-8");
    await rename(temporaryPath, PENDING_TURN_PATH);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function enqueueJournalOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = journalQueue.then(operation, operation);
  journalQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
