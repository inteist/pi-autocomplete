# pi-ghost-vim

Local Copilot-style ghost autocomplete for the Pi prompt editor, designed to wrap `pi-vim` / `pi-vim-mode` instead of replacing it.

The extension asks local Ollama for end-of-prompt completions and only intercepts `Tab` when a valid ghost prediction is visible in insert mode.

## Requirements

```bash
# Default model
ollama pull gemma4:e4b
ollama run gemma4:e4b "Say ready"

# Optional Qwen coder model (FIM prompting)
ollama pull qwen2.5-coder:1.5b

# Optional Liquid LFM2.5 model, expected under the tag LFM25:2.6b
ollama pull hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q8_0
ollama cp hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q8_0 LFM25:2.6b
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

## Commands

Primary command namespace:

- `/ac model` - shows the active Ollama model and prompt mode.
- `/ac model gemma4:e2b` - switches autocomplete to Gemma using instruction-style continuation prompting. The model selection is persisted in the current Pi session.
- `/ac model qwen2.5-coder:1.5b` - switches back to Qwen coder using FIM prompting.
- `/ac model lfm` - switches to Liquid LFM2.5 2.6B (`LFM25:2.6b`) using prefill continuation prompting.
- `/ac model [model] [auto|qwen-fim|instruct|lfm-prefill]` - sets model and optionally overrides prompt handling. `auto` uses Qwen FIM for Qwen coder models, prefill continuation for LFM models, and instruction continuation for others.
- `/ac model list` - shows supported model presets plus configured/default aliases.
- `/ac status` - validates the configured Ollama URL/model and runs a tiny `/api/generate` request. Optional args replace the default diagnostic prompt.
- `/ac debug [on|off]` - toggles a below-editor debug widget and JSONL file tracing showing why predictions are skipped, requested, dropped, or shown.
- `/ac alias add <model> <alias>` - adds a custom model alias.
- `/ac alias list [<model>]` - lists custom/default aliases.
- `/ac alias delete <model> <alias>` - removes one custom alias.
- `/ac alias reset <model>` - removes all custom aliases for a model.

## Behavior

- Insert mode only.
- Predictions are debounced and stale requests are aborted/ignored.
- `Tab` with a visible ghost accepts the next chunk.
- `Tab` again within 350ms accepts the remaining prediction.
- `Tab` without a visible ghost is delegated to Pi/pi-vim.
- `Escape`, normal typing, cursor movement, or leaving insert mode clears the ghost.
- Slash commands, `@` mentions, and likely path tokens suppress local ghost predictions.

The extension renders a dim below-editor preview and also attempts best-effort inline ghost rendering using Pi TUI's cursor marker. Set `PI_GHOST_INLINE=0` to disable inline injection.

## Configuration

Environment variables:

```bash
PI_GHOST_MODEL=gemma4:e4b
PI_GHOST_PROMPT_MODE=auto
PI_GHOST_OLLAMA_URL=http://127.0.0.1:11434
PI_GHOST_KEEP_ALIVE=30m
PI_GHOST_DEBOUNCE_MS=250
PI_GHOST_TIMEOUT_MS=2500
PI_GHOST_CHECK_TIMEOUT_MS=10000
PI_GHOST_DOUBLE_TAB_MS=350
PI_GHOST_MAX_TOKENS=48
PI_GHOST_MIN_CHARS=8
PI_GHOST_INLINE=1
PI_GHOST_DEBUG=0
PI_GHOST_DEBUG_FILE=$PI_CODING_AGENT_DIR/pi-ghost-vim-debug.jsonl
```

### Autocomplete prompt modes

`PI_GHOST_PROMPT_MODE=auto` chooses handling from the active model:

- Qwen coder models use FIM raw completion markers with Ollama `/api/generate` and `raw: true`:

  ```text
  <|fim_prefix|>{text before cursor}<|fim_suffix|><|fim_middle|>
  ```

- LFM models use `lfm-prefill`: a raw ChatML prompt whose final assistant turn is prefilled with the unfinished text, so the model continues that text instead of replying to it. See [LFM2.5 prefill mode](#lfm25-prefill-mode) below.

- Other models, including `gemma4:e2b`, use an instruction-style continuation prompt with a `<cursor>` marker. Gemma models are sent with raw generation because Ollama's Gemma renderer/parser can otherwise return an empty `/api/generate` response for continuation prompts.

You can override the mode with `/ac model [model] qwen-fim`, `/ac model [model] instruct` or `/ac model [model] lfm-prefill`. Model output is post-processed before display: special tokens, prompt echo, labels, and chat/refusal/meta responses are removed or rejected. If the result is not a clean continuation, no ghost text is shown.

### LFM2.5 prefill mode

`LFM25:2.6b` (Liquid `LFM2.5-2.6B`) is a *reasoning* model: its chat template always opens
the assistant turn with `<think>`, and it will spend hundreds of tokens reasoning before it
answers anything. Sent as a normal templated request it never produces a completion inside
the ghost token budget, and Ollama's `think: false` does not suppress it either. Three
things make it usable as an autocompleter:

1. **Raw generation with a pre-closed think block.** The prompt is built by hand as raw
   ChatML and the assistant turn opens with `<think></think>`, which keeps the template
   structure the model expects while skipping the reasoning. `<think>` and `</think>` are
   single tokens in the LFM vocabulary and are parsed as special tokens in raw mode.
2. **Assistant prefill instead of instructions.** The unfinished text is placed at the start
   of the assistant turn, so the model continues its own sentence. Text typed into a prompt
   editor is usually phrased as a request, and an instruction-style prompt makes LFM2.5
   answer that request instead of completing it. Three short few-shot turns anchor the
   format; without them the model paraphrases the tail of the text or drifts into
   multi-sentence commentary.
3. **No dangling trailing space.** Trailing spaces and tabs are trimmed from the text handed
   to the model, because a bare trailing space becomes a standalone token that byte-pair
   tokenizers almost never see (` attempts` is normally one token). Left in place it
   reliably degenerates the output into numeric filler - `the retry logic is ` completes to
   `3 attempts`, `instead of ` to `42` - or an empty response. The model then emits the
   separating space itself and post-processing re-aligns it against the text on screen.

Sampling stays on the extension's deterministic defaults (`temperature=0`,
`repeat_penalty=1.05`). Liquid's recommended settings for this model (`temperature=0.1`,
`top_k=50`, `repeat_penalty=1.1`) measured indistinguishably on completion quality here, and
greedy decoding keeps ghost text stable while typing.

Typical end-to-end latency for the shipped prompt on Apple Silicon with the `Q8_0` build is
~230ms median, ~640ms worst case, with the model usually stopping on its own after fewer
than ten tokens.

### Debug tracing

Enable tracing with `/ac debug on` or `PI_GHOST_DEBUG=1`. In debug mode, every existing debug widget message is also appended as structured JSONL to `PI_GHOST_DEBUG_FILE` (default: `pi-ghost-vim-debug.jsonl` in Pi's agent dir). `PI_GHOST_TRACE_FILE` and `PI_GHOST_DEBUG_TRACE_FILE` are accepted as aliases.

Trace records include scheduling/skip/drop reasons, editor input changes, full prompt payloads sent to Ollama, Ollama response timings/metrics (`total_duration`, `load_duration`, token eval timings), raw responses, cleaned completions, and accept/clear events. The trace file includes prompt text, so only enable it for local debugging.

## Notes

This is intentionally a thin wrapper: pi-vim remains the source of truth for editing and modal behavior. The extension observes text, predicts after a pause, displays ghost text, and consumes `Tab` only when accepting a visible prediction. It also forwards Pi `CustomEditor` action/shortcut hooks to the wrapped editor so shortcuts such as thinking-level bindings continue to work.
