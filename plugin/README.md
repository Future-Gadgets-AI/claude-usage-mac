# claude-usage plugin

Gives Claude Code sessions eyes on the two budgets that end them: the 5-hour usage window and the context window.

## Components

| Component | What it does |
|-----------|--------------|
| `skills/usage-aware-ops` | Breakpoint ladders (usage 50/75/90/95% · context 60/80/90%), elastic model tiering, conservative fail-safe mode, and recipes for watcher/sleep/wake-on-reset. The agent-facing CLI ships inside it at `scripts/claude-usage` |

No agents, hooks, or MCP servers — signals and strategy only.

## Install

From the Future-Gadgets-AI marketplace (HTTPS source):

```
/plugin marketplace add https://github.com/Future-Gadgets-AI/cc-plugins
/plugin install claude-usage@cc-plugins
```

## One-time setup per machine (and after plugin updates)

1. Install the CLI to a stable path (the skill tells you its base directory when it loads):

   ```bash
   install -m 755 <skill-base>/scripts/claude-usage ~/.claude/bin/claude-usage
   ```

2. Wire the statusline (usage segment + context side-channel) — see the [repo README](https://github.com/Future-Gadgets-AI/claude-usage-mac) statusline section. Without it the usage CLI still works, but context files don't refresh.

macOS only (Keychain-based credential read). Requires `jq`.
