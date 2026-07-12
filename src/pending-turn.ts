import { readFile, unlink, writeFile } from "node:fs/promises";

import { PENDING_TURN_PATH } from "./constants";
import type { PendingTelegramTurn } from "./telegram/types";

export async function readPendingTurn(): Promise<PendingTelegramTurn | undefined> {
  try {
    return JSON.parse(
      await readFile(PENDING_TURN_PATH, "utf-8"),
    ) as PendingTelegramTurn;
  } catch {
    return undefined;
  }
}

export async function writePendingTurn(turn: PendingTelegramTurn): Promise<void> {
  await writeFile(PENDING_TURN_PATH, JSON.stringify(turn), "utf-8");
}

export async function removePendingTurn(): Promise<void> {
  try {
    await unlink(PENDING_TURN_PATH);
  } catch {
    // Ignore a missing pending turn.
  }
}
