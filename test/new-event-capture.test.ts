import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SessionEvent } from "../src/types.js";
import { readJsonl } from "../src/parser/jsonl-reader.js";
import { SessionTree } from "../src/parser/session-tree.js";
import { analyzeNetworkTab } from "../src/analyzers/network-tab.js";
import { extractContentParts, sanitizeMetadata } from "../src/analyzers/utils.js";
import { startWebServer } from "../src/web/server.js";

function assistantEvent(overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u0",
    sessionId: "s1",
    timestamp: "2026-01-01T00:00:00.000Z",
    requestId: "req_1",
    isSidechain: false,
    cwd: "/tmp",
    message: {
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 0,
        output_tokens: 20,
      },
    },
    ...overrides,
  } as SessionEvent;
}

describe("jsonl reader accepts sidecar event types", () => {
  it("parses ai-title, agent-name, last-prompt, pr-link, frame-link, queue-operation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cca-reader-"));
    const file = path.join(dir, "session.jsonl");
    const lines = [
      { type: "ai-title", aiTitle: "My Session Title", sessionId: "s1" },
      { type: "agent-name", agentName: "Reviewer", sessionId: "s1" },
      { type: "last-prompt", lastPrompt: "do it", leafUuid: "x", sessionId: "s1" },
      { type: "mode", mode: "normal", sessionId: "s1" },
      { type: "permission-mode", permissionMode: "default", sessionId: "s1" },
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "s1",
        content: "queued prompt",
      },
      {
        type: "pr-link",
        sessionId: "s1",
        prNumber: 7,
        prUrl: "https://github.com/o/r/pull/7",
        prRepository: "o/r",
        timestamp: "2026-01-01T00:00:02.000Z",
      },
      {
        type: "frame-link",
        sessionId: "s1",
        frameUrl: "https://claude.ai/code/artifact/abc",
        title: "Dashboard",
        path: "/tmp/x.html",
        timestamp: "2026-01-01T00:00:03.000Z",
      },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const events = await readJsonl(file);
    const types = events.map((e) => e.type);
    expect(types).toContain("ai-title");
    expect(types).toContain("agent-name");
    expect(types).toContain("last-prompt");
    expect(types).toContain("mode");
    expect(types).toContain("permission-mode");
    expect(types).toContain("queue-operation");
    expect(types).toContain("pr-link");
    expect(types).toContain("frame-link");
  });
});

describe("extractContentParts", () => {
  it("extracts base64 images and replaces them with placeholders", () => {
    const { text, images } = extractContentParts([
      { type: "text", text: "screenshot below" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ]);
    expect(text).toContain("screenshot below");
    expect(text).toContain("[image: image/png]");
    expect(text).not.toContain("aGVsbG8=");
    expect(images).toEqual([{ mediaType: "image/png", data: "aGVsbG8=" }]);
  });

  it("summarizes document blocks without inlining base64", () => {
    const { text, images } = extractContentParts([
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: "x".repeat(4096),
        },
      },
    ]);
    expect(text).toMatch(/\[document: application\/pdf \(\d+ KB\)\]/);
    expect(images).toEqual([]);
  });
});

describe("sanitizeMetadata", () => {
  it("truncates very long strings deep in tool result metadata", () => {
    const meta = {
      type: "image",
      file: { base64: "A".repeat(50_000), filePath: "/a.png" },
      nested: [{ ok: true }],
    };
    const out = sanitizeMetadata(meta) as any;
    expect(out.file.base64.length).toBeLessThan(11_000);
    expect(out.file.base64).toContain("[truncated 40000 chars]");
    expect(out.file.filePath).toBe("/a.png");
    expect(out.nested).toEqual([{ ok: true }]);
  });
});

describe("analyzeNetworkTab new-event enrichment", () => {
  it("scopes sidechain attachments and system events by agentId", () => {
    const events: SessionEvent[] = [
      assistantEvent({ uuid: "a_sub", isSidechain: true, agentId: "agent_9" }),
      {
        type: "attachment",
        uuid: "att1",
        parentUuid: "a_sub",
        timestamp: "2026-01-01T00:00:01.000Z",
        isSidechain: true,
        agentId: "agent_9",
        attachment: { type: "skill_listing", content: "- a-skill", skillCount: 1 },
      } as SessionEvent,
    ];
    const { scopes } = analyzeNetworkTab(new SessionTree(events));
    const agentScope = scopes.find((s) => s.id === "agent_9");
    expect(agentScope).toBeDefined();
    expect(agentScope!.events.some((e) => e.kind === "attachment")).toBe(true);
    expect(scopes.find((s) => s.id === "unknown")).toBeUndefined();
  });

  it("propagates cache miss reason, model, attribution, and API errors", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        attributionSkill: "writing-x-posts",
        isApiErrorMessage: true,
        error: "rate_limit",
        apiErrorStatus: 429,
        message: {
          type: "message",
          role: "assistant",
          model: "claude-fable-5",
          content: [{ type: "text", text: "Rate limited" }],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 0,
            output_tokens: 20,
          },
          diagnostics: {
            cache_miss_reason: {
              type: "tools_changed",
              cache_missed_input_tokens: 63869,
            },
          },
        },
      }),
    ];
    const { scopes } = analyzeNetworkTab(new SessionTree(events));
    const text = scopes[0].events.find((e) => e.kind === "assistant_text");
    expect(text).toBeDefined();
    expect(text!.model).toBe("claude-fable-5");
    expect(text!.attributionSkill).toBe("writing-x-posts");
    expect(text!.cacheMissReason).toEqual({ type: "tools_changed", tokens: 63869 });
    expect(text!.apiError).toBe("rate_limit");
    expect(text!.apiErrorStatus).toBe(429);
    expect(text!.isError).toBe(true);
  });

  it("emits rows for fallback blocks, pr-link, frame-link, and queue-operation", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        message: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "fallback",
              from: { model: "claude-fable-5" },
              to: { model: "claude-opus-4-8" },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      }),
      {
        type: "pr-link",
        sessionId: "s1",
        prNumber: 7,
        prUrl: "https://github.com/o/r/pull/7",
        prRepository: "o/r",
        timestamp: "2026-01-01T00:00:02.000Z",
      } as SessionEvent,
      {
        type: "frame-link",
        sessionId: "s1",
        frameUrl: "https://claude.ai/code/artifact/abc",
        title: "Dashboard",
        timestamp: "2026-01-01T00:00:03.000Z",
      } as SessionEvent,
      {
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-01-01T00:00:04.000Z",
        sessionId: "s1",
        content: "queued prompt",
      } as SessionEvent,
    ];
    const { scopes } = analyzeNetworkTab(new SessionTree(events));
    const summaries = scopes[0].events.map((e) => e.summary);
    expect(summaries).toContain("Model fallback: claude-fable-5 → claude-opus-4-8");
    expect(summaries).toContain("Pull request created: PR #7 — o/r");
    expect(summaries).toContain("Artifact published: Dashboard");
    expect(summaries.some((s) => s.startsWith("Queue enqueue"))).toBe(true);
  });

  it("extracts images from user messages and tool results", () => {
    const events: SessionEvent[] = [
      assistantEvent({
        message: {
          type: "message",
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.png" } },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 1,
          },
        },
      }),
      {
        type: "user",
        uuid: "u_result",
        parentUuid: "a1",
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:01.000Z",
        isSidechain: false,
        cwd: "/tmp",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
                },
              ],
            },
          ],
        },
      } as SessionEvent,
      {
        type: "user",
        uuid: "u_paste",
        parentUuid: "u_result",
        sessionId: "s1",
        timestamp: "2026-01-01T00:00:02.000Z",
        isSidechain: false,
        cwd: "/tmp",
        message: {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "d29ybGQ=" },
            },
          ],
        },
      } as SessionEvent,
    ];
    const { scopes } = analyzeNetworkTab(new SessionTree(events));
    const toolRow = scopes[0].events.find((e) => e.kind === "tool_use");
    expect(toolRow!.toolResultImages).toEqual([
      { mediaType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(toolRow!.toolResultContent).not.toContain("aGVsbG8=");
    const userRow = scopes[0].events.find(
      (e) => e.kind === "user_message" && e.content.includes("look at this")
    );
    expect(userRow!.images).toEqual([{ mediaType: "image/jpeg", data: "d29ybGQ=" }]);
  });

  it("carries richer compaction metadata", () => {
    const events: SessionEvent[] = [
      {
        type: "system",
        uuid: "sys1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:05.000Z",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        isSidechain: false,
        compactMetadata: {
          trigger: "manual",
          preTokens: 400000,
          postTokens: 7000,
          cumulativeDroppedTokens: 393000,
          durationMs: 120000,
        },
      } as SessionEvent,
    ];
    const { scopes } = analyzeNetworkTab(new SessionTree(events));
    const compaction = scopes[0].events.find((e) => e.kind === "compaction");
    expect(compaction!.preTokens).toBe(400000);
    expect(compaction!.postTokens).toBe(7000);
    expect(compaction!.droppedTokens).toBe(393000);
    expect(compaction!.durationMs).toBe(120000);
  });
});

describe("session catalog meta", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("labels sessions with the latest ai-title, skips noise prompts, dedups across roots", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "cca-catalog-"));
    // Keep the settings API from writing the real user config
    process.env.CCEXPLORER_CONFIG_PATH = path.join(base, "config.json");
    cleanups.push(async () => {
      delete process.env.CCEXPLORER_CONFIG_PATH;
    });
    const rootA = path.join(base, "root-a", "projects");
    const rootB = path.join(base, "root-b", "projects");
    const projectA = path.join(rootA, "proj");
    const projectB = path.join(rootB, "proj");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    const sessionLines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "sess-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        isSidechain: false,
        cwd: "/tmp",
        message: {
          role: "user",
          content:
            "<local-command-caveat>Caveat: the messages below were generated...</local-command-caveat>",
        },
      },
      {
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        sessionId: "sess-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        isSidechain: false,
        cwd: "/tmp",
        message: { role: "user", content: "real first prompt" },
      },
      { type: "ai-title", aiTitle: "Old Title", sessionId: "sess-1" },
      { type: "ai-title", aiTitle: "Final Title", sessionId: "sess-1" },
      { type: "last-prompt", lastPrompt: "latest ask", sessionId: "sess-1" },
    ];
    const body = sessionLines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    const fileA = path.join(projectA, "sess-1.jsonl");
    const fileB = path.join(projectB, "sess-1.jsonl");
    await writeFile(fileA, body);
    await writeFile(fileB, body);
    // Make the copy under rootB strictly newer
    const newer = new Date(Date.now() + 5000);
    await utimes(fileB, newer, newer);

    const web = await startWebServer({ port: 0, sessionsRootDir: rootA });
    cleanups.push(web.close);

    // Register rootB as an extra dir via the settings API
    await fetch(`${web.baseUrl}/api/session-dirs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dirs: [path.join(base, "root-b")] }),
    });

    const res = await fetch(`${web.baseUrl}/api/sessions`);
    const sessions = (await res.json()) as Array<{
      fileName: string;
      projectName: string;
      fullPath: string;
      aiTitle?: string;
      lastPrompt?: string;
      firstUserMessage?: string;
    }>;

    const matches = sessions.filter(
      (s) => s.projectName === "proj" && s.fileName === "sess-1"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].fullPath).toBe(fileB);
    expect(matches[0].aiTitle).toBe("Final Title");
    expect(matches[0].lastPrompt).toBe("latest ask");
    expect(matches[0].firstUserMessage).toBe("real first prompt");
  });
});
