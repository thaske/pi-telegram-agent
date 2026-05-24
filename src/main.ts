import { mkdir } from "node:fs/promises";

import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { TelegramBridge } from "./bridge.js";
import { readConfig, writeConfig } from "./config.js";
import { CONFIG_PATH, CWD, TEMP_DIR } from "./constants.js";
import { log } from "./logger.js";

let bridge: TelegramBridge | undefined;
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
let pollingController: AbortController | undefined;

async function main(): Promise<void> {
  const config = await readConfig();
  if (!config.botToken)
    throw new Error(
      `No botToken in ${CONFIG_PATH}. Run /telegram-setup in Pi once or create this config.`,
    );
  await mkdir(TEMP_DIR, { recursive: true });

  bridge = new TelegramBridge(config, writeConfig, () => void shutdown());

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd, agentDir });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        customTools: [bridge!.attachTool],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: CWD,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.continueRecent(CWD),
  });
  bridge.setRuntime(runtime);
  runtime.setRebindSession(async () => bridge!.bindSession());
  await bridge.bindSession();

  // Resume a pending turn if the bot was restarted while processing
  if (await bridge.restorePendingTurn()) {
    log("resumed pending turn");
  }

  const session = bridge.currentSession;
  log(
    `started; cwd=${CWD}; session=${session?.sessionFile ?? session?.sessionId}`,
  );

  pollingController = new AbortController();
  void bridge.pollLoop(pollingController.signal).catch((e) => {
    log(`fatal polling error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}

async function shutdown(): Promise<void> {
  log("shutting down");
  pollingController?.abort();
  await bridge?.shutdown();
  await runtime?.dispose();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await main();
