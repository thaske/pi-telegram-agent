import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  ModelRuntime,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  defineExtension,
  section,
  type AgentChange,
  type HarnessOptions,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";

import { log } from "../logger";
import { createTelegramAttachTool } from "./telegram-attach-tool";

export function defaultStoragePath(cwd: string, agentDir: string): string {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(agentDir, "telegram-agent", key, "state.sqlite");
}

export function selectTools(tools: readonly ToolRegistration[], entries?: string[]): ToolRegistration[] {
  const defaults = tools.map((tool) => tool.name);
  if (entries === undefined) return [...tools];
  const names = new Set(entries.some((entry) => !entry.startsWith("+") && !entry.startsWith("-"))
    ? entries.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-"))
    : entries.length ? defaults : []);
  for (const entry of entries) {
    if (entry.startsWith("+")) names.add(entry.slice(1));
    if (entry.startsWith("-")) names.delete(entry.slice(1));
  }
  return [...names].flatMap((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    return tool ? [tool] : [];
  });
}

/** Reuse Pi's configuration and credential services, not its AgentSession runtime. */
export async function loadDurableConfig(cwd: string, agentDir: string): Promise<{
  options: HarnessOptions;
  agent: AgentChange;
}> {
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
  });
  await loader.reload({
    resolveProjectTrust: async () =>
      new ProjectTrustStore(agentDir).get(cwd) ?? settings.getDefaultProjectTrust() === "always",
  });
  for (const diagnostic of loader.getSkills().diagnostics) log(`skill: ${diagnostic.message}`);
  for (const error of settings.drainErrors()) throw error.error;

  const models = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const available = await models.getAvailable();
  const model = available.find((candidate) =>
    candidate.provider === settings.getDefaultProvider() && candidate.id === settings.getDefaultModel(),
  ) ?? available[0];
  if (!model) throw new Error("No authenticated Pi models are available. Configure Pi credentials before starting the bot.");

  const coding = createCodingTools();
  const tools = selectTools(coding.tools ?? [], settings.getDefaultTools());
  const skillReader = tools.some((tool) => tool.name === "read") ? "read"
    : tools.some((tool) => tool.name === "bash") ? "bash" : "indirect";
  const attach = createTelegramAttachTool();
  const registry = createRegistry();
  // Keep host tool policy in the registry, so settings changes also restrict reopened conversations.
  registry.install(defineExtension({ ...coding, tools }));
  registry.install(defineExtension({
    name: "telegram",
    tools: [attach],
    sections: [
      section("system", () => loader.getSystemPrompt() ?? "You are a coding assistant.", { tag: false }),
      section("append", () => loader.getAppendSystemPrompt().join("\n\n") || undefined, { tag: false }),
      section("context", () => loader.getAgentsFiles().agentsFiles.map((file) => `# ${file.path}\n\n${file.content}`).join("\n\n") || undefined),
      section("skills", () => formatSkillsForPrompt(loader.getSkills().skills, skillReader) || undefined, { tag: false }),
      section("cwd", (input) => input.env?.cwd),
    ],
  }));

  return {
    agent: {
      cwd,
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel: settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel() ?? "medium",
    },
    options: {
      models,
      registry,
      env: ({ cwd: directory }) => new NodeExecutionEnv({ cwd: directory ?? cwd, shellPath: settings.getSettings().shellPath }),
      settings: {
        retry: settings.getRetrySettings(),
        compaction: settings.getCompactionSettings(model),
        steeringMode: settings.getSteeringMode(),
        followUpMode: settings.getFollowUpMode(),
        stream: { transport: settings.getTransport(), ...settings.getProviderRetrySettings() },
      },
      onReport: (error) => log(`durable error: ${error instanceof Error ? error.message : String(error)}`),
    },
  };
}
