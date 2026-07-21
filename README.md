# Claude Code Session Explorer

A browser-based inspector for Claude Code JSONL session transcripts. Think Chrome DevTools' Network tab, but for understanding what Claude did during a coding session — every tool call, thinking block, context window shift, and subagent spawn laid out on a single interactive timeline.

<img alt="Claude Code Session Explorer — timeline with agent scopes, badges, and detail panel" src="https://raw.githubusercontent.com/escottalexander/ccexplorer/main/docs/screenshot.jpg" />

## Why

Claude Code sessions can run for hundreds of turns across multiple subagents, consuming tokens in ways that are hard to reason about from the raw JSONL. This tool lets you:

- Watch a session live as Claude works — the timeline updates automatically
- See exactly where context tokens are spent and when compactions fire
- Trace tool call chains and inspect their inputs/outputs
- Understand subagent lifecycles — which tool spawned them, what they did
- Spot errors, slow calls, and repeated patterns at a glance

## Quick Start

### Run with npx

```bash
npx ccexplorer
```

To open a specific session file:

```bash
npx ccexplorer ~/.claude/projects/<project>/<session-id>.jsonl
```

### Local development

```bash
npm install
npm start
```

Opens the explorer at `http://127.0.0.1:3457`. It auto-discovers all sessions from `~/.claude/projects/`.

`npm start` runs the CLI locally (`ccexplorer`) via `tsx`.

## Features

### Event Timeline

The main view is a filterable table of every event in the session, ordered chronologically:

- **Tool calls** — name, input, result, duration, and error status
- **Thinking blocks** — model reasoning with token usage
- **Assistant text** — response content, with API errors (rate limits, auth failures) flagged in red
- **User messages** — prompts, tool results, and pasted images/documents
- **Hooks** — pre/post hook executions (deduplicated from command+callback pairs)
- **System events** — turn durations, away-summaries, model fallbacks, stop hooks, queued prompts, PR links, published artifacts
- **Compaction events** — context resets with trigger reason and before/after token counts
- **Attachments** — skill listings, tool/agent/MCP deltas, plan-mode transitions, task reminders

Each row shows the context added (Ctx+), running context total, time, and timestamp. Rows carry badges for subagent spawns, API errors, skill attribution, and embedded images.

### Context Tracking

- **Running total column** resets to zero after compaction boundaries
- **Context sparkline** — an inline area chart showing token usage over time, with compaction drops marked as vertical lines. Click anywhere on the chart to jump to that event.
- **Cache-miss diagnostics** — when the prompt cache is invalidated (e.g. `tools_changed`), the Ctx+ cell and detail panel explain why and how many tokens were re-read
- **Hover breakdown** — hover the Total column to see cache read, cache creation, input, and output token counts
- **Streaming deduplication** — events sharing a requestId (streamed chunks from the same API call) are dimmed with an `↑` indicator to avoid double-counting

### Agent Scopes

Sessions with subagents show a scope picker on the left. Each agent (main, Task subagents, compaction subagents) has its own timeline. Events that spawn a subagent display a purple **Spawns Subagent** badge, and the detail panel links directly to that agent's scope.

### Detail Panel

Click any row to inspect it. The detail panel shows:

- **Tool calls** — JSON tree viewer for input (collapsible, syntax-highlighted), full result text, embedded result images rendered inline, metadata from tool_result events, success/error badge
- **Thinking/Assistant** — full content with token breakdown, plus the model and reasoning effort that produced the turn and any skill/agent/MCP attribution
- **User messages** — text plus rendered pasted images
- **Compaction** — trigger, before/after/freed token counts, duration, link to compaction subagent
- **All events** — timestamp badge, context info with hover breakdown

### Filtering

- **Kind pills** — toggle event types (Tool, Thinking, User, Assistant, Hook, System, Compaction) with a three-state cycle: show all → solo → exclude
- **Tool pills** — filter by specific tool names within the current scope
- **Status pills** — filter by ok/error
- **Search** — full-text search across summaries, tool names, IDs, and content
- **Min Time** — filter tool calls by minimum duration

### Session Browser

A modal session picker groups sessions by project. Each session is labeled with its AI-generated title (falling back to agent name, then the first real user prompt — harness noise like local-command caveats is skipped) and shows a relative last-active time. Search matches titles, prompts, and file names. Sessions are sorted by recency, and duplicates of the same session across multiple data directories are collapsed to the newest copy. The active session is polled for changes and the timeline updates live.

Extra Claude data directories (e.g. `~/.claude-personal`) can be added in the ⚙ settings modal; the config lives at `~/.claude/ccexplorer-config.json` (override the location with the `CCEXPLORER_CONFIG_PATH` environment variable).

### Navigation

Back/forward buttons track your selection history across scope jumps and row selections, similar to browser navigation.

## Architecture

```
src/
  cli.ts                  — CLI entry point (published as `ccexplorer`)
  index.ts                — programmatic entry point
  types.ts                — shared TypeScript types for all events and analysis
  parser/
    jsonl-reader.ts       — reads session JSONL bundles (main + subagent files)
    session-tree.ts       — builds a tree of events with tool pairing
  analyzers/
    network-tab.ts        — builds scoped event timelines with tool pairs
    reasoning-chain.ts    — chronological thinking/tool/text timeline
    tool-dashboard.ts     — tool stats, file access patterns, sequential patterns
    context-tracker.ts    — per-turn token tracking with compaction resets
    skill-detector.ts     — estimates token impact of CLAUDE.md and skill files
  web/
    server.ts             — HTTP server with session discovery and caching
    public/
      index.html          — shell HTML
      app.js              — single-file UI application
      styles.css           — dark theme styles
```

## Development

```bash
npm test           # run tests once
npm run test:watch # watch mode
```

## Publish

```bash
npm publish --access public
```

The `prepack` script builds TypeScript and copies static web assets into `dist/` so the CLI works when installed via npm.
