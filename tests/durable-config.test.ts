import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

import { defaultStoragePath, loadDurableConfig, selectTools } from "../src/pi/config";

test("durable tool selection respects Pi defaultTools restrictions and modifiers", () => {
  const tools = CodingTools.tools ?? [];
  const names = (entries?: string[]) => selectTools(tools, entries).map((tool) => tool.name).sort();
  expect(names()).toEqual(["bash", "edit", "read", "write"]);
  expect(names([])).toEqual([]);
  expect(names(["-bash"])).toEqual(["edit", "read", "write"]);
  expect(names(["read", "+bash", "-read"])).toEqual(["bash"]);
  expect(names(["grep"])).toEqual([]);
  expect(selectTools(tools, ["write", "read"]).map((tool) => tool.name)).toEqual(["write", "read"]);
});

test("default durable storage is persistent and separated by working directory", () => {
  const first = defaultStoragePath("/work/one", "/agent");
  expect(first).toStartWith("/agent/telegram-agent/");
  expect(first).toEndWith("/state.sqlite");
  expect(first).toBe(defaultStoragePath("/work/one/.", "/agent"));
  expect(first).not.toBe(defaultStoragePath("/work/two", "/agent"));
});

for (const policy of ["ask", "never"]) {
  test(`malformed untrusted project settings cannot prevent startup under ${policy}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-untrusted-settings-"));
    const agentDir = join(dir, "agent"), cwd = join(dir, "workspace");
    try {
      await mkdir(agentDir);
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: policy }));
      await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "offline" } }));
      await writeFile(join(cwd, ".pi", "settings.json"), "{ invalid json");
      const config = await loadDurableConfig(cwd, agentDir);
      expect(config.agent.model).toBeDefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("configuration reuses prompts, skills and policy without executing SDK extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-config-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  const marker = join(dir, "extension-executed");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "skills", "sample"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProjectTrust: "always",
    defaultTools: ["-bash"],
    retry: { enabled: false },
    defaultThinkingLevel: "low",
  }));
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test-key" } }));
  await writeFile(join(agentDir, "SYSTEM.md"), "Configured system instructions.");
  await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Configured additional instructions.");
  await writeFile(join(cwd, "AGENTS.md"), "Project context.");
  await writeFile(join(cwd, ".pi", "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: A configured workflow.\n---\nWorkflow details.");
  await writeFile(join(cwd, ".pi", "extensions", "legacy.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default () => {};`);
  let harness: Harness | undefined;
  try {
    const config = await loadDurableConfig(cwd, agentDir);
    expect(config.agent.thinkingLevel).toBe("low");
    expect(config.options.settings?.retry?.enabled).toBe(false);
    harness = await Harness.open(new MemoryStorage(), config.options, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: config.agent });
    const agent = await root.agent(BACKGROUND_CONTEXT);
    expect(agent.tools.map((tool) => tool.name)).not.toContain("bash");
    const rendered = await Promise.all(agent.sections.map(async (section) => section.render({
      conversationId: root.id, agent, env: undefined, shown: {}, read: harness!,
    }, BACKGROUND_CONTEXT)));
    expect(rendered.join("\n")).toContain("Configured system instructions.");
    expect(rendered.join("\n")).toContain("Configured additional instructions.");
    expect(rendered.join("\n")).toContain("Project context.");
    expect(rendered.join("\n")).toContain("A configured workflow.");
    expect(await access(marker).then(() => true, () => false)).toBe(false);
  } finally {
    await harness?.close(BACKGROUND_CONTEXT);
    await rm(dir, { recursive: true, force: true });
  }
});
