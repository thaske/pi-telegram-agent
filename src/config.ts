import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { CONFIG_PATH } from "./constants";
import type { TelegramConfig } from "./telegram/types";

export async function readConfig(): Promise<TelegramConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as TelegramConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(next: TelegramConfig): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, "\t") + "\n", "utf8");
}
