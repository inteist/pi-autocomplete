# pi-ghost-vim

Local Copilot-style ghost autocomplete for the Pi prompt editor, designed to wrap `pi-vim` / `pi-vim-mode` instead of replacing it.

The extension asks local Ollama for end-of-prompt completions and only intercepts `Tab` when a valid ghost prediction is visible in insert mode.

## Requirements

```bash
ollama pull qwen2.5-coder:1.5b
ollama run qwen2.5-coder:1.5b "Say ready"
```

Ollama must be reachable at `http://127.0.0.1:11434` unless overridden.

## Usage

Load this extension **after** pi-vim/pi-vim-mode:

```bash
pi -e pi-vim-mode -e ./index.ts
```

or, from an absolute path:

```bash
pi -e pi-vim-mode -e /path/to/pi-ghost-vim/index.ts
```

For auto-discovery, copy or symlink this directory into a Pi extension/package location, or use Pi package settings with the `pi.extensions` entry in `package.json`.

## Behavior

- Insert mode only.
- Predictions are debounced and stale requests are aborted/ignored.
- `Tab` with a visible ghost accepts the next chunk.
- `Tab` again within 350ms accepts the remaining prediction.
- `Tab` without a visible ghost is delegated to Pi/pi-vim.
- `Escape`, normal typing, cursor movement, or leaving insert mode clears the ghost.
- Slash commands, `@` mentions, and path-like text ending in `/` suppress local ghost predictions.

The extension renders a dim below-editor preview and also attempts best-effort inline ghost rendering using Pi TUI's cursor marker. Set `PI_GHOST_INLINE=0` to disable inline injection.

## Configuration

Environment variables:

```bash
PI_GHOST_MODEL=qwen2.5-coder:1.5b
PI_GHOST_OLLAMA_URL=http://127.0.0.1:11434
PI_GHOST_KEEP_ALIVE=30m
PI_GHOST_DEBOUNCE_MS=250
PI_GHOST_TIMEOUT_MS=900
PI_GHOST_DOUBLE_TAB_MS=350
PI_GHOST_MAX_TOKENS=48
PI_GHOST_MAX_PREFIX_CHARS=2500
PI_GHOST_MIN_CHARS=20
PI_GHOST_INLINE=1
```

## Notes

This is intentionally a thin wrapper: pi-vim remains the source of truth for editing and modal behavior. The extension observes text, predicts after a pause, displays ghost text, and consumes `Tab` only when accepting a visible prediction.
