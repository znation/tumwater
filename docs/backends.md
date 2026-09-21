# Backends

tumwater drives pi, and pi drives a model backend. Nothing in the harness is tied to a
particular one: any OpenAI-compatible endpoint pi can reach will do.

## What a backend must provide

- **An OpenAI-compatible endpoint pi can reach** — a hosted provider's base URL, or a local
  server. Name it with `provider` and `model` in `tumwater.json` (and a per-role override under
  `roles.<id>` when a single loop needs a different model).
- **A context window large enough for a tick prompt.** Every tick starts a fresh pi session
  (~8k-token prefill), but a dense tick grows to tens of thousands of tokens before it ends.
  Declare an honest `contextWindow` for the model in pi's `models.json` — it is what pi uses to
  decide when to compact, and the number that keeps a tick off the backend's real ceiling.

## How the config points at it

`provider`, `model`, and `thinking` in `tumwater.json` name the model every loop uses;
`fallbackModel` names the free model role loops switch to once `maxDailyCostUsd` is spent — the
budgeted model does the day's paid work, the free one keeps the fleet alive afterwards:

```json
"provider": "<paid-provider>", "model": "<paid-model>",
"fallbackModel": { "provider": "<free-provider>", "model": "<free-model>" }
```

Only a provider/model pair pi's `models.json` prices at zero is accepted as a fallback, so the
switch cannot spend past the cap: an unknown id, a priced model, or a missing definitions file is
refused and the fleet pauses instead. `fleetModelsFree()` reads that same catalog to decide the
budget badge, which reads `· budget: $10.02/$10 today · fallback: <model> (cost n/a)` while the
fallback is carrying the fleet.

## Worked example: one machine's measurements, 2026-09

The configuration and measurements below are one operator's rig, recorded as a concrete example
rather than a recommendation. Replace every value with your own backend's.

**A budgeted API primary with the local server as the cost n/a
fallback.** tumwater.json names `huggingface` / `deepseek-ai/DeepSeek-V4.1-Flash` (HF Inference
Providers' OpenAI-compatible router at `https://router.huggingface.co/v1`) with
`maxDailyCostUsd` 10, and `fallbackModel` `omlx` / `Qwen3.8-27B-MLX-oQ4e-mtp` — so the fleet
spends up to $10/day on the API model and then keeps working locally for free until local
midnight. pi 0.84.2 ships a built-in `huggingface` provider whose catalog predates V4.1-Flash, so
`~/.pi/agent/models.json` adds just that model (declared at $0.30/$1.20 per million tokens — the
highest rate among the providers the router auto-selects as of 2026-09-18, so the cap trips no
later than real spend) and inherits the provider's base URL and env-based key. **The key is the
one thing not in any config file: export `HF_TOKEN` in the environment that runs `tumwater run`**
(`pi auth check --provider huggingface --json` reports `ready` once it is set). The two models'
context windows differ by an order of magnitude (1,048,576 vs 126,928); ticks start a fresh pi
session with a small prefill, so a switch mid-day is safe, but a role prompt written for the API
model's window would not be.

**Local backend: oMLX (MLX), since 2026-09-14.** `/Applications/oMLX.app` 0.7.0.dev2 serves
`fcmeyer/Qwen3.8-27B-MLX-oQ4e-mtp` (API id `Qwen3.8-27B-MLX-oQ4e-mtp`) at `127.0.0.1:8000` — an
imatrix-calibrated ~4.9 bpw quant that preserves the model's native MTP head, so oMLX runs
Lightning MTP speculative decoding (2.5–3.0 tokens per backbone cycle at 68–84% draft acceptance;
the `lmstudio-community` checkpoints carry no MTP tensors, making `mtp_enabled` a no-op there).
oMLX config lives outside this repo in `~/.omlx/`: `model_settings.json` sets
`max_context_window` **131072**, pinned + default;
`settings.json` sets `max_concurrent_requests` **3**, `memory_guard_tier` aggressive,
`hot_cache_max_size` 4GB and an API key. pi (`~/.pi/agent/`) and omp
(`~/.omp/agent/models.yml` — YAML, not models.json) both use provider `omlx`,
`api: openai-completions`, `contextWindow` **126928** (a 4144-token margin under the server's
limit for pi's output reserve), and must send the API key. `tumwater.json`
names `provider`/`model` explicitly so `fleetModelsFree()` sees a free fleet, with
`maxConcurrent` **3** — the three role loops alone saturate all three slots (at 2, one slot
sat idle whenever the director was not running, which is most of the time), and the
director's bypass makes a fourth client only while it is active (~10–15% of ticks); the
fourth request queues rather than joins the batch (`max_num_seqs` stays 3), so MTP draft
acceptance is untouched, and its measured 103–118 s TTFT sits well inside pi's 30-min idle
timeout and the harness's quiet watchdog. Measured server-reported:
**35.2 tok/s per stream at ~51k context** (fleet paused); a slot sweep at ~20k context put 3 slots
ahead of 4 on every axis — 73.3 aggregate / 24.4 per stream / 74.2% draft acceptance / 28.3 GiB
peak wired, versus 65.0 / 16.2 / 69.7% / 32.6 GiB — because MTP acceptance falls monotonically with
concurrency (unaligned batches drop back to standard decode). Rate is strongly context-dependent,
so quote a context size with any tok/s figure.

Do not reach for the slot count to fix memory pressure: it was tried twice (6→4, then 4→3) and
moved nothing either time. At 3 slots the live footprint was pool ~57 GB / KV 10.8 GB / hot cache 0
/ model 16 GB — the pinned MLX buffer pool is ~60% of it and does not scale with concurrency.

A third deliberate value: `max_context_window` is **131072, not the model's 262144 maximum**. At the
full window oMLX aborted prefills outright — `Request aborted: process memory limit exceeded (usage
111.0 GB, abort threshold (hard watermark) 92.1 GB, metal_cap ceiling 96.9 GB)` — killing 9 ticks,
three at a time, because `_get_dynamic_ceiling` is recomputed every poll and collapses when the rest
of the Mac is busy, taking the abort threshold down with it. Halving the window halves the
worst-case prefill transient and KV. Live ticks peak around 64-80k, so 131072 still leaves ~1.6x
headroom. The companion fix is `memory_guard_tier: aggressive` (active-reclaim ratio 0.5 -> 0.8),
which holds the ceiling at the Metal cap instead of letting it collapse, plus `hot_cache_max_size`
4GB. **Slot count is not a lever here** — it was tried twice (6->4, 4->3) and moved nothing; the
pinned MLX pool is ~60% of the footprint and does not scale with concurrency.

Two oMLX settings are deliberately left at non-obvious values:
- `chunked_prefill` stays **false** (its default). Turning it on collapsed throughput ~20× here
  (16.4 → 0.8 tok/s, TTFT 118 s): the fleet's large prefills interleave continuously and starve
  decode.
- `prefill_memory_guard` is **on** (re-enabled 2026-09-14 with the 16 GB oQ4e model). It had been
  turned off under the earlier 8-bit model, where oMLX's pinned buffer pool
  (`mx.set_cache_limit(total_mem)`, issue #300 — otherwise `allocator::free()` can release a Metal
  buffer the GPU still holds and panic on M4) made the enforcer read the pinned pool as pressure:
  562 trips in 46 min, each forcing a synchronized `clear_cache()` that stalled every stream — a
  visible sawtooth in tok/s — while wired memory oscillated ~40 ↔ 107 GiB. With the 16 GB model the
  peak wired across the whole slot sweep was 49.7 GiB against the 96.8 GiB soft watermark, and the
  guard has logged 0 pressure trips in 30 min — the OOM safety net is back with no stalls.

The bullets below were written for the previous **LM Studio / GGUF** backend and are kept as
hard-won background; the llama.cpp-specific parts (unified KV, slot allocation, q8_0 flags) no
longer describe what runs.


- **LM Studio WARN flood** (`Reasoning setting 'high' is not supported by model '…'. Supported
  settings: 'on', 'off'. Falling back to reasoning setting 'on'.`): benign. pi requests its
  configured thinking level per turn; GGUF models that only expose an on/off reasoning toggle make
  LM Studio warn and fall back to `on`. Reasoning stays enabled; no tumwater or pi change needed.
  To silence it, set a thinking level the model supports (or none) in `tumwater.json` / pi settings.
- **"terminated" tick errors after ~20 minutes**: pi's HTTP client (undici) applies an idle
  timeout (`httpIdleTimeoutMs` in pi's settings.json, default 300000 = 5 min) to both response
  headers and gaps between body chunks. A local server prefilling a large context under
  concurrent load can take longer than that to stream its first byte, so the request is severed
  ("terminated"), pi's retries die the same way, and the tick fails after ~4 × 5 min. Fix: set
  a large-but-finite `"httpIdleTimeoutMs"` (e.g. `1800000` = 30 min) in
  `~/.pi/agent/settings.json`. Do not use `0` (fully disabled): a zombie socket then waits
  forever. The harness's `quietTimeoutSeconds` watchdog (default 30 min; kills a run when no
  *progress* — message, turn, and tool boundary events — happens, so content-free keepalives
  cannot reset it) and `tickTimeoutSeconds` remain the layered hang guards.
- **Context accounting**: declare an honest `contextWindow` for the model in pi's `models.json` —
  it is what triggers pi's auto-compaction. With LM Studio's unified KV cache, concurrent requests
  share one context pool (declare pool ÷ slots); with unified KV off, each slot owns the full
  window. A session that overruns the server's real limit fails with "Context size has been
  exceeded"; since every tick runs a fresh session, the next tick is unaffected.
- **Truncated-at-the-ceiling turns look like normal stops**: as a session nears the declared
  `contextWindow`, pi clamps each request's `max_output_tokens` to the space remaining (down
  to a floor of 16). LM Studio's `/v1/responses` reports a generation stopped by that clamp
  as status `completed` rather than `incomplete`/`max_output_tokens`, so pi sees stopReason
  "stop" instead of "length" and its compact-and-retry overflow handling never fires — the
  turn ends mid-thought with no text and no tool call, the agent loop finishes, and the tick
  lands as `no_change` with a "finished without changes and without declaring nothing-to-do"
  warning (now annotated with "likely cut off at the context ceiling"). Prevention: tumwater
  starts every tick in a fresh session, so ticks begin with only the prompt (~8k tokens) and
  need ~75k of within-tick growth to reach the cliff — several hours of dense work. Note that
  pi never compacts MID-run (only at end of run), so a single extremely long tick can still
  hit the cliff; the tick then ends with the warning above, any files pi already edited are
  still committed, and — when no changes landed — the loop does not idle-backoff: its next
  tick resumes the session pi just compacted at end of run (short bridge prompt, same task),
  effectively mid-task compaction at tick granularity. After 3 consecutive cut-offs on one
  task it gives up and falls back to a fresh tick with normal backoff; a cut-off director
  prompt is re-queued and reruns fresh.
- **Match clients to slots, or prefix caches thrash**: each server slot keeps the KV prefix of
  the last request it served. Keep the number of concurrent tumwater clients — `maxConcurrent`
  plus one for the director's bypass — at or below the server's slot count. One client over, and
  slots keep evicting each other's session prefixes: with persistent multi-10k-token sessions,
  nearly every turn re-prefills from scratch (minutes each), requests queue behind those
  prefills, and starved ticks die as "no pi progress" watchdog kills even though the server is
  healthy. Symptom to look for: small-context requests timing out while the server log shows
  continuous back-to-back prompt processing.
- **A unified KV pool cannot exceed the model's training context; dedicated slots can grow per
  stream**: with unified KV on, llama.cpp treats the shared pool as the slot context and caps it at
  `n_ctx_train` — asking Qwen3.8-27B for 524288 logs "the slot context exceeds the training context
  of the model — capping" and comes up as 262144 — so per-stream headroom under unified KV is
  pool ÷ slots and can never grow past that. For a larger window per stream, turn unified KV
  **off** and set the context length per slot. Measured 2026-09-07 with 3 × 174080-token slots
  (~64 GB wired, ~110 KB of KV per token on this model): three concurrent streams interleave at
  8.3–8.4 tok/s each, aggregate 24.8 tok/s — identical to unified-on, and equal to a single
  stream's 24.2, because the GPU is the bottleneck either way. The strictly serial serving seen
  earlier under unified-off was memory pressure at 4 × 262144 slots (~115 GB), not the mode
  itself. At f16 three full 262144-token slots would need ~101 GB (86 GB of KV plus the weights) —
  the wedge zone — so the KV cache is stored at q8_0 instead (LM Studio's saved load config:
  `llm.load.llama.kCacheQuantizationType` / `vCacheQuantizationType` = q8_0 with flash attention on),
  which brings 3 × 262144 slots to ~62 GB wired with three streams still at 7.8–8.3 tok/s each.
  Historical LM Studio configuration (superseded by oMLX, above): unified KV off, context-length 262144 (the model's maximum),
  parallel 3, q8_0 K/V cache, pi `contextWindow` 258000 (a margin under the slot for pi's output
  reserve), `maxConcurrent` 2 (+ the director's bypass = 3 clients ≤ 3 slots). Keep the model's
  saved default in LM Studio identical to the live load: a just-in-time load after an idle unload
  otherwise reverts to whatever the default says.
- **KV memory with dedicated slots**: unified-off KV buffers are allocated per slot — at ~110 KB
  per token (f16; q8_0 halves it), 4 × 262144-token slots cost ~100 GB of KV on top of the weights (~115 GB total),
  which runs a 128 GB machine at the edge: heavy swapping, and the engine can wedge permanently
  in `PROCESSINGPROMPT` (predictions hang, API reports "Engine protocol predict request failed:
  fetch failed", `lms ps` shows a phantom prefill). Unified-on at the same pool is ~25 GB.
  Recover a wedged engine with `lms unload <model>` + `lms load <model> --context-length N
  --parallel K`.
