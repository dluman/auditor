# my-pi-extension

A [Pi](https://pi.dev) extension that logs LLM interactions to a write-only key/value store and exports recent prompts as patch files.

## Install

```bash
# From npm
pi install npm:my-pi-extension

# From git
pi install git:github.com/youruser/my-pi-extension

# From a local path
pi install /path/to/my-pi-extension
```

## Usage

- `/log-path` — Show the path to the interaction log.
- `create_patch_from_prompts` — Tool that writes recent user prompts to a patch file.

Interactions are appended to `.pi/.sessions` (inside the Pi config directory for the current working directory). Each prompt is stored as a single JSON array containing all related events, from the user input through the end of the agent turn. Use the `PI_CODING_AGENT_DIR` environment variable to override the base directory; the `.pi` subdirectory is always appended.

## License

MIT
