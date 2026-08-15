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
- `/ac trace [on|off]` - shows where traces are written plus today's counts, or switches recording on/off (persisted).
- `/ac debug [on|off]` - toggles a below-editor debug widget and the verbose event stream showing why predictions are skipped, requested, dropped, or shown.
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
PI_AC_TRACE=1
PI_AC_TRACE_DIR=~/.pi/ac-traces
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

## Trace collection

Every completion attempt is recorded as one JSON object on one line of a daily file:

```text
~/.pi/ac-traces/ac-trace-2026-08-10.jsonl      # completions and submitted prompts
~/.pi/ac-traces/debug/ac-debug-2026-08-10.jsonl # verbose event stream (/ac debug only)
```

The location is fixed per machine rather than per project - Pi's agent dir moves with
`PI_CODING_AGENT_DIR`, which would scatter the corpus across checkouts - and each record
carries its own `session.cwd`, so per-project slicing still works after the fact. Override
the location with `PI_AC_TRACE_DIR`, switch recording off with `/ac trace off` or
`PI_AC_TRACE=0`, and use `/ac trace` to see today's counts.

### What a record holds

A completion record is only written once its outcome is known, because the interesting
half of a trace is what the user did next. The schema (`ac-trace/0.1.0`) borrows its
conventions from [Agent Trace](https://agent-trace.dev) - semver `schema`, UUID `id`, RFC
3339 `ts`, a `tool` block, a models.dev-style `model.id` - but nothing of its structure,
which is about attributing committed lines rather than keystroke-time suggestions.

| Field | Why it is there |
| --- | --- |
| `context.prefix` / `word_prefix` / `trigger` | Exactly what was on screen, the unfinished word, and the keystroke that fired the request. |
| `prompt.text` / `prompt.hash` | The full string sent to Ollama, few-shots and control tokens included. The hash groups records by prompt template so two prompt variants can be compared. |
| `response.raw` / `completion` / `reject_reason` | Model output before and after cleanup, plus why it was refused. |
| `outcome.status` | `accepted_full`, `accepted_partial`, `shown_rejected`, `filtered`, `stale`, `error`. |
| `outcome.accepted_text` | The part of the suggestion that made it into the buffer. |
| `outcome.typed_text` | What actually followed that prefix, resolved from the submitted prompt where possible. |
| `outcome.match` | Suggestion against reality: shared prefix length and ratio, raw and normalised. |
| `timing.*` | Debounce served, HTTP roundtrip, keystroke-to-ghost latency, and Ollama's own token timings. |

A `submission` record is written per submitted prompt with the final text and the
composition stats, including `accepted_ratio` - how much of the prompt came from
autocomplete. The final text is the strongest ground truth available for what a completion
should have predicted, so keeping it next to the attempts is the point of the file.

### Analysing a day

```bash
cd ~/.pi/ac-traces

# Accept rate per prompt mode
jq -rs 'map(select(.type=="completion" and .outcome.shown)) | group_by(.model.prompt_mode)[]
        | "\(.[0].model.prompt_mode) \(map(select(.outcome.status|startswith("accepted")))|length)/\(length)"' ac-trace-*.jsonl

# Suggestions that were refused but that the user then typed anyway
jq -c 'select(.outcome.status=="filtered" and .outcome.match.common_prefix_ratio > 0.5)
       | {reject: .response.reject_reason, raw: .response.raw, typed: .outcome.typed_text}' ac-trace-*.jsonl

# Where the suggestion diverged from reality, worst first
jq -c 'select(.outcome.shown) | {ratio: .outcome.match.common_prefix_ratio,
       prefix: .context.prefix, suggested: .response.completion, typed: .outcome.typed_text}' ac-trace-*.jsonl \
  | jq -s 'sort_by(.ratio)[:20]'
```

Records contain the prompt text you typed. They never leave the machine, but treat the
directory as you would your shell history; `/ac trace off` stops recording, and deleting a
day file is enough to drop it.

### Debug tracing

`/ac debug on` (or `PI_GHOST_DEBUG=1`) adds the below-editor debug widget and a second,
much noisier daily file under `<trace dir>/debug/`: one line per internal event -
scheduling, skip and drop reasons, editor input, the Ollama request and response, cleanup,
accepts and clears. That is the file to read when chasing why one specific ghost did or
did not appear; the completion traces above are the file to analyse in bulk.

## Notes

This is intentionally a thin wrapper: pi-vim remains the source of truth for editing and modal behavior. The extension observes text, predicts after a pause, displays ghost text, and consumes `Tab` only when accepting a visible prediction. It also forwards Pi `CustomEditor` action/shortcut hooks to the wrapped editor so shortcuts such as thinking-level bindings continue to work.
