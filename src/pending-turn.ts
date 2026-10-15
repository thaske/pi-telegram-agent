import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

import { PENDING_TURN_PATH } from "./constants";
import type { PendingTelegramTurn } from "./telegram/types";

export async function migratePendingTurn(
  admit: (turn: PendingTelegramTurn) => Promise<boolean>,
  path = PENDING_TURN_PATH,
): Promise<boolean> {
  const turn = await readPendingTurn(path);
  if (!turn) return false;
  // Removing the legacy file is safe only after durable admission (or deduplication).
  await admit(turn);
  await removePendingTurn(turn.id, path);
  return true;
}

/** Read-only compatibility with the pre-durable delivery journal. */
export async function readPendingTurn(path = PENDING_TURN_PATH): Promise<PendingTelegramTurn | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf-8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
  const turn = JSON.parse(serialized) as PendingTelegramTurn;
  turn.id ||= `legacy-${createHash("sha256").update(serialized).digest("hex")}`;
  return turn;
}

export async function removePendingTurn(expectedTurnId: string, path = PENDING_TURN_PATH): Promise<boolean> {
  const pending = await readPendingTurn(path);
  if (!pending) return false;
  if (pending.id !== expectedTurnId)
    throw new Error(`Refusing to remove pending Telegram turn ${pending.id}; expected ${expectedTurnId}`);
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
