# auditor

A [Pi](https://pi.dev) extension that continuously persists the current agent session to a project-local JSONL file and automatically restores history into fresh sessions.

## Install

```bash
# From npm
pi install npm:auditor

# From git
pi install git:github.com/dluman/auditor

# From a local path
pi install /path/to/auditor
```

## What it does

- **Auto-export** — Every agent session is periodically written to `.session.jsonl` in the project root. The file is updated on a timer (default: every 5 minutes) and again when the session shuts down. Exports are append-only, so existing history is never overwritten.
- **Auto-import** — When a new session starts with no prior messages, the extension automatically reads `.session.jsonl` from the project root and injects the previous session history as context. A status indicator in the footer shows when history is ready or loaded.
- **Patch tool** — `create_patch_from_prompts` creates a JSON patch file containing recent session entries with timestamps, model names, tool results, and other metadata.

## Configuration

Open Pi Settings to change the **Auto-export interval**:

- `0` — disables automatic exports
- `5`, `10`, `30`, `60` — minutes between background exports (default: `5`)

Manual exports still occur on shutdown regardless of the timer setting.

## Files

- `.session.jsonl` — Append-only JSONL session archive in the current working directory. Each line is a JSON object: a session header followed by all entries in the current branch.

## License

MIT
