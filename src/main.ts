import { mkdir } from "node:fs/promises";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { TelegramBridge } from "./bridge";
import { readConfig, writeConfig } from "./config";
import { CONFIG_PATH, CWD, TEMP_DIR } from "./constants";
import { log } from "./logger";
import { migratePendingTurn } from "./pending-turn";
import { defaultStoragePath, loadDurableConfig } from "./pi/config";
import { DurableTelegramAgent } from "./pi/durable-agent";

let bridge: TelegramBridge | undefined;
let agent: DurableTelegramAgent | undefined;
let pollingController: AbortController | undefined;
let polling: Promise<void> | undefined;
let shutdownPromise: Promise<void> | undefined;

async function main(): Promise<void> {
  const config = await readConfig();
  if (!config.botToken) throw new Error(`No botToken in ${CONFIG_PATH}. Create this config before starting the bot.`);
  await mkdir(TEMP_DIR, { recursive: true });

  const agentDir = getAgentDir();
  const storagePath = process.env.PI_TELEGRAM_STORAGE ?? defaultStoragePath(CWD, agentDir);
  const durable = await loadDurableConfig(CWD, agentDir);
  agent = await DurableTelegramAgent.open(await openNodeSqliteStorage(storagePath), durable.options, durable.agent);
  void agent.harness.closed.then((end) => {
    if (end.reason === "failed") {
      log(`durable storage failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`);
      void shutdown(1);
    }
  });
  await migratePendingTurn((turn) => agent!.enqueueTurn(turn));
  bridge = new TelegramBridge(config, writeConfig, agent, () => void shutdown(1));
  if (await bridge.restorePendingTurns()) log("restored durable Telegram work");
  agent.harness.resume();
  log(`started; cwd=${CWD}; storage=${storagePath}; conversation=${agent.conversationId}`);

  pollingController = new AbortController();
  polling = bridge.pollLoop(pollingController.signal);
  void polling.catch((error) => {
    if (pollingController?.signal.aborted) return;
    log(`fatal polling error: ${error instanceof Error ? error.message : String(error)}`);
    void shutdown(1);
  });
}

function shutdown(exitCode = 0): Promise<void> {
  if (exitCode) process.exitCode = exitCode;
  shutdownPromise ??= (async () => {
    log("shutting down");
    pollingController?.abort();
    try {
      await polling?.catch(() => undefined);
      await bridge?.shutdown();
      await agent?.close();
    } catch (error) {
      log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    process.exit(process.exitCode ?? exitCode);
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  await main();
} catch (error) {
  log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
