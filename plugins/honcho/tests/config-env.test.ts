import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runInSandbox } from "./sandbox";

function loadSaveMessages(fileConfig: Record<string, unknown>, env: Record<string, string>): boolean {
  const home = mkdtempSync(join(tmpdir(), "honcho-home-"));
  try {
    mkdirSync(join(home, ".honcho"), { recursive: true });
    writeFileSync(join(home, ".honcho", "config.json"), JSON.stringify({ apiKey: "k", peerName: "t", ...fileConfig }));
    const out = runInSandbox(
      home,
      `import { loadConfig } from "./src/config.ts";
       console.log(JSON.stringify(loadConfig("claude_code")?.saveMessages));`,
      env,
    );
    return JSON.parse(out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("HONCHO_SAVE_MESSAGES over a config file", () => {
  // The README documents HONCHO_SAVE_MESSAGES=false as the way to stop saving
  // messages. Whenever config.json exists the env var has to win over it, or
  // it silently does nothing.
  test.each([
    ["file without saveMessages, env false", {}, { HONCHO_SAVE_MESSAGES: "false" }, false],
    ["root saveMessages: true, env false", { saveMessages: true }, { HONCHO_SAVE_MESSAGES: "false" }, false],
    ["host-block saveMessages: true, env false", { hosts: { claude_code: { saveMessages: true } } }, { HONCHO_SAVE_MESSAGES: "false" }, false],
    ["file saveMessages: false, env true (env only turns saving off)", { saveMessages: false }, { HONCHO_SAVE_MESSAGES: "true" }, false],
    ["file saveMessages: true, env unset", { saveMessages: true }, {}, true],
  ])("%s", (_name, fileConfig, env, expected) => {
    expect(loadSaveMessages(fileConfig, env)).toBe(expected);
  });

  test("the env override is not written back to config.json", () => {
    // Session setup calls saveConfig with the merged config. A runtime
    // HONCHO_SAVE_MESSAGES=false must not become a durable host setting.
    const home = mkdtempSync(join(tmpdir(), "honcho-home-"));
    try {
      mkdirSync(join(home, ".honcho"), { recursive: true });
      const configPath = join(home, ".honcho", "config.json");
      writeFileSync(configPath, JSON.stringify({ apiKey: "k", peerName: "t", saveMessages: true }));
      runInSandbox(
        home,
        `import { setSessionForPath } from "./src/config.ts";
         setSessionForPath("/tmp/project", "project-session");`,
        { HONCHO_SAVE_MESSAGES: "false" },
      );
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(written.sessions["/tmp/project"]).toBe("project-session");
      expect(written.saveMessages).toBe(true);
      expect(written.hosts?.claude_code?.saveMessages).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function withHome<T>(fileConfig: Record<string, unknown>, fn: (home: string, configPath: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "honcho-home-"));
  try {
    mkdirSync(join(home, ".honcho"), { recursive: true });
    const configPath = join(home, ".honcho", "config.json");
    writeFileSync(configPath, JSON.stringify({ apiKey: "k", peerName: "t", ...fileConfig }));
    return fn(home, configPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("HONCHO_AI_PEER and HONCHO_WORKSPACE over a config file", () => {
  // Hosts such as codex run this plugin as claude_code. HONCHO_AI_PEER set per
  // process gives them their own AI peer; a shell hook sets HONCHO_WORKSPACE
  // per repo. Neither may be written back, or every later session is pinned.
  test("HONCHO_AI_PEER overrides the resolved AI peer", () => {
    const out = withHome({ workspace: "w" }, (home) =>
      runInSandbox(home, `import { loadConfig } from "./src/config.ts";
        console.log(loadConfig("claude_code")?.aiPeer);`, { HONCHO_AI_PEER: "codex" }));
    expect(out).toBe("codex");
  });

  test("env workspace and AI peer are not written to the host block", () => {
    withHome({ workspace: "root-ws", globalOverride: false }, (home, configPath) => {
      runInSandbox(home, `import { loadConfig, setSessionForPath } from "./src/config.ts";
        console.log(loadConfig("claude_code")?.workspace);
        setSessionForPath("/tmp/project", "project-session");`,
        { HONCHO_WORKSPACE: "repo-ws", HONCHO_AI_PEER: "codex" });
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(written.sessions["/tmp/project"]).toBe("project-session");
      expect(written.hosts?.claude_code?.workspace).toBeUndefined();
      expect(written.hosts?.claude_code?.aiPeer).toBeUndefined();
    });
  });

  test("an explicit host-block AI peer survives a run with HONCHO_AI_PEER", () => {
    withHome({ hosts: { claude_code: { workspace: "w", aiPeer: "mine" } } }, (home, configPath) => {
      runInSandbox(home, `import { setSessionForPath } from "./src/config.ts";
        setSessionForPath("/tmp/project", "project-session");`, { HONCHO_AI_PEER: "codex" });
      expect(JSON.parse(readFileSync(configPath, "utf-8")).hosts.claude_code.aiPeer).toBe("mine");
    });
  });
});
