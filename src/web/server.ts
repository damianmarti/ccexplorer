import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import type { SessionEvent } from "../types.js";
import type { SessionTree } from "../parser/session-tree.js";
import { analyzeNetworkTab } from "../analyzers/network-tab.js";
import { analyzeReasoningChain } from "../analyzers/reasoning-chain.js";
import { analyzeToolDashboard } from "../analyzers/tool-dashboard.js";
import { analyzeContext } from "../analyzers/context-tracker.js";
import { analyzeSkills } from "../analyzers/skill-detector.js";
import { readSessionBundle } from "../parser/jsonl-reader.js";
import { SessionTree as BuiltSessionTree } from "../parser/session-tree.js";

export interface StartWebServerOptions {
  tree?: SessionTree;
  events?: SessionEvent[];
  port?: number;
  sessionsRootDir?: string;
  initialSessionPath?: string;
}

export interface RunningWebServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function configPath(): string {
  return (
    process.env.CCEXPLORER_CONFIG_PATH ??
    join(homedir(), ".claude", "ccexplorer-config.json")
  );
}

interface CcExplorerConfig {
  sessionDirs: string[];
}

async function readConfig(): Promise<CcExplorerConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.sessionDirs)) {
      return { sessionDirs: parsed.sessionDirs };
    }
  } catch {
    // missing or malformed config
  }
  return { sessionDirs: [] };
}

async function writeConfig(config: CcExplorerConfig): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

async function discoverAllSessions(
  defaultDir: string
): Promise<SessionCatalogEntry[]> {
  const config = await readConfig();
  const dirs = [defaultDir, ...config.sessionDirs.map((d) => join(d, "projects"))];
  const seen = new Set<string>();
  const allEntries: SessionCatalogEntry[] = [];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const entries = await discoverSessions(dir);
    allEntries.push(...entries);
  }
  // The same session file can exist under multiple roots (e.g. ~/.claude and
  // ~/.claude-personal). Keep only the most recently modified copy.
  const byIdentity = new Map<string, SessionCatalogEntry>();
  for (const entry of allEntries) {
    const identity = `${entry.projectName}/${entry.fileName}`;
    const existing = byIdentity.get(identity);
    if (!existing || (entry.mtimeMs ?? 0) > (existing.mtimeMs ?? 0)) {
      byIdentity.set(identity, entry);
    }
  }
  return [...byIdentity.values()].sort(
    (a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
  );
}

export async function startWebServer(
  options: StartWebServerOptions
): Promise<RunningWebServer> {
  const {
    tree,
    events,
    port = 0,
    sessionsRootDir = join(homedir(), ".claude", "projects"),
    initialSessionPath,
  } = options;

  let catalog = await discoverAllSessions(sessionsRootDir);
  let catalogTimestamp = Date.now();
  const CATALOG_TTL_MS = 5000;
  const cache = new Map<string, { mtimeMs: number; analysis: Awaited<ReturnType<typeof analyzeSessionPath>> }>();

  if (tree && events && initialSessionPath) {
    const key = sessionKeyFromPath(initialSessionPath);
    const fileStat = await stat(initialSessionPath).catch(() => null);
    cache.set(key, { mtimeMs: fileStat?.mtimeMs ?? 0, analysis: analyzeSessionFromTree(tree, events, initialSessionPath) });
    if (!catalog.some((entry) => entry.sessionKey === key)) {
      catalog.unshift(sessionEntryFromPath(initialSessionPath, key));
    }
  } else if (tree && events && !initialSessionPath) {
    const syntheticPath = "in-memory-session.jsonl";
    const key = sessionKeyFromPath(syntheticPath);
    cache.set(key, { mtimeMs: 0, analysis: analyzeSessionFromTree(tree, events, syntheticPath) });
    catalog.unshift(sessionEntryFromPath(syntheticPath, key));
  } else if (initialSessionPath) {
    const key = sessionKeyFromPath(initialSessionPath);
    if (!catalog.some((entry) => entry.sessionKey === key)) {
      catalog.unshift(sessionEntryFromPath(initialSessionPath, key));
    }
  }

  const publicDir = join(fileURLToPath(new URL(".", import.meta.url)), "public");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const selectedKey = resolveSessionKey(url.searchParams.get("session"), catalog);
    if (!selectedKey && url.pathname.startsWith("/api/")) {
      return json(res, 404, { error: "No sessions available" });
    }

    if (url.pathname === "/api/sessions") {
      if (Date.now() - catalogTimestamp > CATALOG_TTL_MS) {
        catalog = await discoverAllSessions(sessionsRootDir);
        catalogTimestamp = Date.now();
      }
      return json(res, 200, catalog);
    }

    if (url.pathname === "/api/session-dirs") {
      if (req.method === "GET") {
        const config = await readConfig();
        return json(res, 200, {
          defaultDir: dirname(sessionsRootDir),
          extraDirs: config.sessionDirs,
        });
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed.dirs)) {
          return json(res, 400, { error: "Expected { dirs: string[] }" });
        }
        const config: CcExplorerConfig = { sessionDirs: parsed.dirs };
        await writeConfig(config);
        // Force catalog refresh
        catalog = await discoverAllSessions(sessionsRootDir);
        catalogTimestamp = Date.now();
        return json(res, 200, {
          defaultDir: dirname(sessionsRootDir),
          extraDirs: config.sessionDirs,
        });
      }
    }

    const analysis = selectedKey
      ? await getAnalysis(selectedKey, cache, catalog)
      : null;
    if (url.pathname.startsWith("/api/") && !analysis) {
      return json(res, 404, { error: "Session not found" });
    }

    if (url.pathname === "/api/session") {
      return json(res, 200, {
        sessionKey: selectedKey,
        sessionPath: analysis!.sessionPath,
        sessionId: analysis!.sessionId,
        totalEvents: analysis!.events.length,
        timeline: analysis!.timeline,
        toolStats: analysis!.toolStats,
        fileAccess: analysis!.fileAccess,
        toolPatterns: analysis!.toolPatterns,
        tokenTurns: analysis!.tokenTurns,
        compactionEvents: analysis!.compactionEvents,
        skillImpacts: analysis!.skillImpacts,
      });
    }

    if (url.pathname === "/api/network") {
      return json(res, 200, { scopes: analysis!.network.scopes });
    }

    if (url.pathname === "/api/network/filters") {
      const toolNames = new Set<string>();
      const statuses = new Set<string>();
      const eventKinds = new Set<string>();
      for (const scope of analysis!.network.scopes) {
        for (const req of scope.requests) {
          toolNames.add(req.toolName);
          statuses.add(req.isError ? "error" : "ok");
        }
        for (const evt of scope.events) {
          eventKinds.add(evt.kind);
        }
      }
      if (statuses.size === 0) statuses.add("ok");
      return json(res, 200, {
        toolNames: [...toolNames].sort((a, b) => a.localeCompare(b)),
        statuses: [...statuses].sort((a, b) => a.localeCompare(b)),
        eventKinds: [...eventKinds].sort((a, b) => a.localeCompare(b)),
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveFile(res, join(publicDir, "index.html"));
    }
    if (url.pathname === "/app.js") {
      return serveFile(res, join(publicDir, "app.js"));
    }
    if (url.pathname === "/styles.css") {
      return serveFile(res, join(publicDir, "styles.css"));
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const host = "127.0.0.1";
  const MAX_PORT_ATTEMPTS = 100;

  if (port === 0) {
    await listen(server, port, host);
  } else {
    let currentPort = port;
    let attempts = 0;
    while (true) {
      try {
        await listen(server, currentPort, host);
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EADDRINUSE") {
          throw err;
        }
        attempts += 1;
        if (attempts >= MAX_PORT_ATTEMPTS) {
          throw new Error(
            `Could not find an open port starting at ${port} after ${MAX_PORT_ATTEMPTS} attempts`
          );
        }
        currentPort += 1;
      }
    }
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

function listen(
  server: import("node:http").Server,
  port: number,
  host: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function serveFile(
  res: import("node:http").ServerResponse,
  filePath: string
): Promise<void> {
  try {
    const content = await readFile(filePath, "utf8");
    res.writeHead(200, { "content-type": getContentType(filePath) });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function getContentType(filePath: string): string {
  const ext = extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function sessionKeyFromPath(filePath: string): string {
  return Buffer.from(filePath).toString("base64url");
}

function sessionEntryFromPath(filePath: string, sessionKey: string) {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1]?.replace(/\.jsonl$/, "") ?? filePath;
  const projectName = parts[parts.length - 2] ?? "";
  return {
    sessionKey,
    fileName,
    projectName,
    fullPath: filePath,
  };
}

interface SessionMeta {
  firstUserMessage?: string;
  aiTitle?: string;
  agentName?: string;
  lastPrompt?: string;
}

interface SessionCatalogEntry extends SessionMeta {
  sessionKey: string;
  fileName: string;
  projectName: string;
  fullPath: string;
  mtimeMs?: number;
}

// Session meta requires a full-file scan (ai-title is updated over the life of
// a session, so the last occurrence wins). Cache per path+mtime so the catalog
// refresh only re-reads files that changed.
const sessionMetaCache = new Map<string, { mtimeMs: number; meta: SessionMeta }>();

/** True for user messages that are harness noise rather than a real prompt. */
function isNoiseUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<local-command-caveat>") ||
    trimmed.startsWith("Caveat: The messages below") ||
    trimmed.startsWith("<command-name>") ||
    trimmed.startsWith("<command-message>") ||
    trimmed.startsWith("<task-notification>") ||
    trimmed.startsWith("<system-reminder>")
  );
}

/**
 * Scan a session JSONL once, collecting the first real user prompt and the
 * latest ai-title / agent-name / last-prompt sidecar records.
 */
async function extractSessionMeta(
  filePath: string,
  mtimeMs: number
): Promise<SessionMeta> {
  const cached = sessionMetaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;

  const meta: SessionMeta = {};
  try {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      // Cheap substring pre-filter before parsing
      const wantsUser =
        meta.firstUserMessage === undefined && line.includes('"type":"user"');
      const wantsSidecar =
        line.includes('"type":"ai-title"') ||
        line.includes('"type":"agent-name"') ||
        line.includes('"type":"last-prompt"');
      if (!wantsUser && !wantsSidecar) continue;
      try {
        const parsed = JSON.parse(line);
        if (
          wantsUser &&
          parsed.type === "user" &&
          !parsed.isSidechain &&
          !parsed.isMeta &&
          typeof parsed.message?.content === "string" &&
          parsed.message.content.trim().length > 0 &&
          !isNoiseUserMessage(parsed.message.content)
        ) {
          meta.firstUserMessage = parsed.message.content.trim();
        } else if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
          meta.aiTitle = parsed.aiTitle;
        } else if (parsed.type === "agent-name" && typeof parsed.agentName === "string") {
          meta.agentName = parsed.agentName;
        } else if (parsed.type === "last-prompt" && typeof parsed.lastPrompt === "string") {
          meta.lastPrompt = parsed.lastPrompt;
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // file not readable
  }

  sessionMetaCache.set(filePath, { mtimeMs, meta });
  return meta;
}

async function discoverSessions(rootDir: string): Promise<SessionCatalogEntry[]> {
  const projects = await readdir(rootDir).catch(() => []);
  const entries: SessionCatalogEntry[] = [];

  for (const project of projects) {
    const projectPath = join(rootDir, project);
    const projectStat = await stat(projectPath).catch(() => null);
    if (!projectStat?.isDirectory()) continue;
    const files = await readdir(projectPath).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const fullPath = join(projectPath, file);
      const fileStat = await stat(fullPath).catch(() => null);
      const meta = await extractSessionMeta(fullPath, fileStat?.mtimeMs ?? 0);
      entries.push({
        sessionKey: sessionKeyFromPath(fullPath),
        fileName: file.replace(/\.jsonl$/, ""),
        projectName: project,
        fullPath,
        mtimeMs: fileStat?.mtimeMs,
        ...meta,
      });
    }
  }

  return entries.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
}

function resolveSessionKey(
  requestedKey: string | null,
  catalog: Array<{ sessionKey: string }>
): string | null {
  if (requestedKey && catalog.some((entry) => entry.sessionKey === requestedKey)) {
    return requestedKey;
  }
  return catalog[0]?.sessionKey ?? null;
}

async function getAnalysis(
  key: string,
  cache: Map<string, { mtimeMs: number; analysis: Awaited<ReturnType<typeof analyzeSessionPath>> }>,
  catalog: Array<{ sessionKey: string; fullPath: string }>
) {
  const entry = catalog.find((item) => item.sessionKey === key);
  if (!entry) return null;
  const existing = cache.get(key);
  if (existing) {
    const fileStat = await stat(entry.fullPath).catch(() => null);
    if (fileStat && fileStat.mtimeMs > existing.mtimeMs) {
      const analyzed = await analyzeSessionPath(entry.fullPath);
      cache.set(key, { mtimeMs: fileStat.mtimeMs, analysis: analyzed });
      return analyzed;
    }
    return existing.analysis;
  }
  const fileStat = await stat(entry.fullPath).catch(() => null);
  const analyzed = await analyzeSessionPath(entry.fullPath);
  cache.set(key, { mtimeMs: fileStat?.mtimeMs ?? 0, analysis: analyzed });
  return analyzed;
}

async function analyzeSessionPath(fullPath: string) {
  const events = await readSessionBundle(fullPath);
  const tree = new BuiltSessionTree(events);
  return analyzeSessionFromTree(tree, events, fullPath);
}

function analyzeSessionFromTree(
  tree: SessionTree,
  events: SessionEvent[],
  sessionPath: string
) {
  const network = analyzeNetworkTab(tree);
  const timeline = analyzeReasoningChain(tree);
  const { toolStats, fileAccess, toolPatterns } = analyzeToolDashboard(tree);
  const { tokenTurns, compactionEvents } = analyzeContext(tree);
  const { skillImpacts } = analyzeSkills(tree);
  const sessionId = tree.getSessionId() ?? "unknown";
  return {
    sessionPath,
    sessionId,
    events,
    network,
    timeline,
    toolStats,
    fileAccess,
    toolPatterns,
    tokenTurns,
    compactionEvents,
    skillImpacts,
  };
}
