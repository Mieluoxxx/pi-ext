# pi-advisor configuration

Complete reference for `advisor.json` — where it lives, every key it accepts, and how the per-executor blocklist is evaluated.

## Where the file lives

`advisor.json` resolves under the XDG config directory:

| `XDG_CONFIG_HOME` | Resolved path |
| --- | --- |
| unset, empty, or whitespace-only | `~/.config/rpiv-advisor/advisor.json` |
| absolute path | `$XDG_CONFIG_HOME/rpiv-advisor/advisor.json` |
| `~` or `~/…` | tilde expanded, then used as the config dir |
| relative path | ignored → `~/.config/rpiv-advisor/advisor.json` |
| `~user/…` | not expanded → `~/.config/rpiv-advisor/advisor.json` |

`XDG_CONFIG_HOME` selects the configuration directory. `PI_CACHE_RETENTION`
selects the cache lifetime profile used by optional warming.

**Legacy read fallback.** If nothing exists at the XDG-resolved path, reads fall
back once to `~/.config/rpiv-advisor/advisor.json` (always `~/.config`, ignoring
`XDG_CONFIG_HOME`). If the XDG path *does* exist, it wins — even when it is
malformed. **Writes always go to the XDG-resolved path only**; there is no
migration or copy of the legacy file.

A missing or malformed file is treated as `{}` — malformed JSON logs a warning
and never crashes the extension.

## File permissions

`/advisor` writes the file with `JSON.stringify(config, null, 2)` plus a
trailing newline, creating parent directories as needed, then chmods it to
`0600` on a best-effort basis. A failed chmod does not fail the save; on Windows
the chmod is a no-op.

Saving happens **before** any in-memory state changes. If the write fails you
get `Failed to save advisor selection — selection not persisted` and both the
previous selection and the active tool list are left untouched.

## Keys

| Key | Type | Default | Written by |
| --- | --- | --- | --- |
| `modelKey` | `string` — `"provider/modelId"` | absent (advisor off) | `/advisor` |
| `effort` | graded thinking level (`minimal` → `max`) | absent (no `reasoning` sent) | `/advisor` effort picker |
| `disabledForModels` | `(string \| { model, minEffort? })[]` | `[]` | hand-edited |
| `budget` | object — see below | $1 soft, $3 hard, $20/branch, 250k cold context, 420s per consultation | hand-edited |
| `warming` | object — see below | enabled when TTL and native usage recording are available | hand-edited |
| `review` | object — see below | off | hand-edited |
| `guidance.promptSnippet` | `string` | built-in snippet | hand-edited |
| `guidance.promptGuidelines` | `string[]` | six built-in guidelines | hand-edited |

`/advisor` only ever writes `modelKey` and `effort`; `guidance`,
`disabledForModels`, `budget`, `warming` and `review` are preserved across saves, so hand-edits survive.

### `modelKey`

The canonical persisted form is slash-separated — `anthropic/claude-opus-4-5`.
Reads also accept the legacy colon form (`anthropic:claude-opus-4-5`); when both
forms are present the slash form wins. A colon-form key is rewritten to slash
form the next time you save through `/advisor`.

### `effort`

Offered only for models whose registry entry reports reasoning support. The
picker lists `off (no reasoning sent)` plus the graded levels Pi reports for the
selected model. `high` is marked `(recommended)`. Choosing `off` deletes the
key, and no `reasoning` parameter is sent with the advisor call — distinct from
`/rpiv-models`' `off (disable reasoning)`, which persists an explicit
`thinking: "off"`.

`EFFORT_ORDINAL` orders the graded levels lowest → highest; this ordering is what
`minEffort` compares against.

> **Naming note.** Advisor "effort", Pi's "thinking level", and pi-ai's `reasoning`
> parameter are the same graded-level concept — the name differs per layer (fixed by
> on-disk config keys and upstream APIs), but there is no semantic distinction.

### Same-model rule

Advisor is always inactive when its model ID equals the executor's model ID,
including the same ID through a different provider and regardless of reasoning
effort. The execution entry point also skips any stale or direct tool invocation
before resolving credentials or sending a request. Model aliases with different
IDs are not inferred to be equivalent. The selection stays saved and becomes
active again when the executor switches to a different, unblocked model.

### `disabledForModels`

A list of **executor** models for which the advisor tool should be stripped —
useful when you are already driving a top-tier model and do not want to pay for
a second opinion. Two entry forms:

```json
{
  "modelKey": "anthropic/claude-opus-4-5",
  "effort": "high",
  "disabledForModels": [
    "anthropic/claude-opus-4-5",
    { "model": "openai/gpt-5.2", "minEffort": "high" }
  ]
}
```

- **String entry** — blocks at any reasoning effort.
- **Object entry without `minEffort`** — blocks at any reasoning effort.
- **Object entry with `minEffort`** — blocks when the executor's current effort
  is at or above the threshold in `EFFORT_ORDINAL`. Ties block.
- An executor effort of `off` or unset never matches a `minEffort` entry.

Entry keys are canonicalised to slash form before comparison, so a legacy
`"anthropic:claude-opus-4-5"` entry still blocks without a re-save.

**Validation.** A non-array value becomes `[]`. Empty strings are dropped.
Object entries need a non-empty string `model`; an unrecognised `minEffort`
drops the entry. `null`, numbers, booleans and `undefined` are dropped. The
order of surviving entries is preserved.

**Live re-evaluation.** The blocklist is re-applied on `session_start`, on every
turn, whenever you switch executor model, and whenever you change reasoning
effort — so the tool strips and re-adds mid-session as you move around. You see
`Advisor disabled for <provider/model>` when it strips and
`Advisor restored: <label>[, <effort>]` when it comes back.

### `guidance`

Overrides what the executor model is told about *when* to escalate, without
forking the package.

- `guidance.promptSnippet` — a non-empty string replacing the one-line snippet
  that appears in the system prompt.
- `guidance.promptGuidelines` — a non-empty array of non-empty strings replacing
  the six built-in guidelines.

Either field falls back to its built-in default when absent, empty, or the wrong
type. Both are read once at extension load, so restart your Pi session after
editing them.

The built-in guidelines tell the model to call `advisor` before substantive
work, again when it believes the task is complete (after making the deliverable
durable), and when it is stuck or considering a change of approach; to weight
the advice seriously unless empirically contradicted; and to reconcile
conflicting evidence with one more `advisor` call rather than silently switching.

## Notifications

| String | When |
| --- | --- |
| `Advisor: <label>[, <effort>]` | you selected a model with `/advisor` |
| `Advisor: <label>[, <effort>] (inactive for current executor)` | selected, but same-model or blocked by `disabledForModels` |
| `Advisor restored: <label>[, <effort>]` | re-applied at session start, or unblocked mid-session |
| `Advisor restored: <label>[, <effort>] (inactive for current executor)` | restored while blocked |
| `Advisor disabled` | you chose **No advisor** |
| `Advisor disabled for <provider/model>` | you switched to the advisor model or a blocklisted executor model/effort |
| `Advisor selection not found: <choice>` | the model you picked was no longer in the available-model list when `/advisor` resolved the choice |
| `Previously configured advisor model <key> is no longer available` | the saved model left Pi's registry |
| `Failed to save advisor selection — selection not persisted` | the write to `advisor.json` failed |
| `/advisor requires interactive mode` | `/advisor` ran without a TTY |

The `Advisor restored: …` announcement fires at most once per process, so
programmatic session spawns (workflow stages, subagents) do not repeat it.


### `budget`

```json
{
  "budget": {
    "perCallSoftUsd": 1,
    "perCallHardUsd": 3,
    "sessionUsd": 20,
    "warmWindowSec": 1800,
    "contextBudgetTokens": 250000,
    "timeoutSec": 420,
    "onExceed": "confirm"
  }
}
```

These are the defaults. Numeric values must be finite and nonnegative; invalid
fields fall back to their defaults. Zero USD requires approval for any positive
estimated spend; `warmWindowSec: 0` always estimates cold input. `onExceed` accepts
`"confirm"` or `"skip"`. Settings are read on each consultation and survive `/advisor`
selection changes.

The gate checks both the estimated cost of the call (including any already billed
attempt) and the current branch's advisor spend plus that estimate. An interactive
confirmation displays both the expected and cold-cache costs. Declining, selecting
`"skip"`, or exceeding the limit without a UI returns a skipped result telling the
executor to continue without retrying. Automatic empty-response retries go through
the same gate and retain the cost of the first attempt.

Input is estimated from the previous actual prompt plus new content when its
fingerprint matches; otherwise Pi's token heuristic is used with 20% headroom.
Expected cache reads require the same model, effort, session routing key, system
prompt and message prefix within `warmWindowSec`, with no intervening compaction
or branch summary. Output uses the last five reported positive output counts for
this model and effort. Without that history the output length is unknown and is
left out of the estimate, so a first consultation reads lower than it will bill.
Prices come from Pi's model registry;
configure accurate prices for custom models. Unreported cache-write charges are
not included in the estimate.

These limits govern estimates, not final invoices: cache eviction, token estimation,
output variability, provider-internal retries and unreported usage can change the
actual bill. The ledger is rebuilt from advisor tool results on the current branch,
including failures, old `details.usage` records and native advisor warming usage entries. Switching branches or restarting
needs no separate balance file. Concurrent calls that have not yet returned are
not present in that ledger.

When a cold request exceeds both `perCallSoftUsd` and `contextBudgetTokens`, the
ledger drops its oldest cards. Every user message in the dropped span is re-stated
verbatim ahead of a fixed omission marker, so trimming costs executor activity and
never the user's own words. If dropping every card still does not fit, the verbatim
tail's per-part cap is reduced in steps (4000 / 2000 / 1000 / 500 characters) rather
than abandoning the consultation: a truncated view of the failing step is more
useful than none.

The boundary is sticky. The last dropped entry's session ID is persisted with
`pi.appendEntry`, and later requests resume just after it, so a warm follow-up
reproduces the same prefix instead of re-deriving a boundary that drifts as the
branch grows. It advances only when cold and over budget again. Compaction and
branch summaries reset it. The original transcript is never edited.

`contextBudgetTokens: 0` disables trimming and ignores saved anchors. A warm view
retains its full prefix even if it exceeds this token target. The hard USD gate
still applies.

`timeoutSec` caps one consultation's wall-clock time, investigation rounds
included. The executor is blocked while it waits, so a stalled provider stream is
cut off and the executor receives `Advisor timed out after <n>s` with the
instruction to continue without retrying. Time spent waiting on a budget
confirmation does not count. `0` disables the cap. The default sits above the
slowest successful consultation measured in real sessions (p99 269s, max 547s).

A failed request is re-sent once when pi-ai classifies the failure as transient
(overload, 5xx, an upstream stream that ended early, a request timeout), and only
while less than half of `timeoutSec` has elapsed. Deterministic failures such as a
context-window overflow are returned immediately. The retry passes the same budget
gate as every other request and its billed attempt is kept. Hosts whose pi-ai has
no transient-error classifier keep the previous behaviour: no retry.

### `ledger`

```json
{
  "ledger": {
    "tailToolCalls": 2,
    "tailMaxChars": 8000,
    "userMessageMaxChars": 20000,
    "customPreviewChars": 500
  }
}
```

Controls how the executor's branch is compiled for the advisor. Older tool rounds
become one-line cards (`#id tool · argument · status · size · ✗ first error line`);
the newest `tailToolCalls` rounds are sent verbatim, each part capped at
`tailMaxChars`. Executor reasoning is dropped from history and kept only in that
tail. Values must be finite and nonnegative.

Replayed over 1500 real consultations, this cut total prompt tokens by 89.5%
(385.2M to 40.5M; median request 183.7k to 21.3k tokens) with no request larger
than the payload it replaced.

`userMessageMaxChars` bounds a single user message; a longer one keeps its head and
tail with a marked, `advisor_expand`-able gap in the middle. Every user message on
the branch is otherwise sent verbatim, including messages from before a compaction
that Pi's own context builder would have replaced with its summary — that summary is
labelled as a paraphrase so it is not mistaken for the user's intent.

No image is ever embedded in the ledger, because anything embedded would sit in the
append-only prefix of every later consultation and be re-uploaded on each request.
Images are referenced instead:

- A **tool-produced** image lives on disk and its card already names the file, so the
  advisor calls `read` on that path when the picture matters. The bytes then arrive
  inside one investigation round and go no further. `read` only returns an image to a
  vision-capable advisor model (`input` includes `image`); a text-only model gets a
  marker, since it would reject the request.
- An image the **user pasted** into the terminal has no path: Pi's `ImageContent`
  carries only `{data, mimeType}`. The ledger names it and says no path exists, so the
  advisor asks the executor what it showed instead of guessing.

For context accounting an image counts as a fixed 1200 tokens, matching Pi's own
`ESTIMATED_IMAGE_CHARS`. Vision models price an image by its dimensions, not by the
length of its base64, so measuring the encoded bytes overstates an attachment by
orders of magnitude — enough to make the trim logic discard history that costs
nothing to keep.

`customPreviewChars` bounds an extension-authored message preview. Extension
messages hidden from the user (`display: false`) and `!!` shell runs excluded from
the executor's own context are withheld from the advisor too.

### `tools`

```json
{
  "tools": {
    "enabled": true,
    "maxRounds": 3,
    "maxResultChars": 12000,
    "repo": true,
    "denyPatterns": [".env", ".env.*", "*.pem", "*.key", "id_rsa*", "*.p12", "*.pfx"]
  }
}
```

The advisor's read-only investigation surface. Because older rounds arrive as
cards, it needs a way back to the evidence:

- `advisor_expand({ids})` returns the verbatim text behind a card — what happened.
- `read` / `grep` / `find` / `ls` read the workspace as it is now — what is.
- `git_diff({path, patch, staged})` shows the net change, via fixed argv with no
  shell. It returns `--stat` unless `patch: true`.

`maxRounds` bounds the extra model requests one consultation may spend on
investigation; every round is priced against `perCallHardUsd` and `sessionUsd`
before it is sent. When the allowance runs out the tool declarations are left
unchanged — withdrawing them would rewrite the head of the cached prefix — and the
advisor is told in-band to answer with what it has.

Paths are resolved through `realpath` and must stay inside the session cwd, so a
symlink cannot escape the workspace even when its target does not exist yet.
`denyPatterns` refuses credential-shaped files; a configured list replaces the
defaults rather than merging, so access can be deliberately widened. The advisor is
a second provider seeing this repository, which is why these files are denied to it
even though the executor's own `read` would serve them. No mutating tool is ever
declared. `repo: false` leaves only `advisor_expand`; `enabled: false` or
`maxRounds: 0` sends a single request with no tools at all.

### `warming`

```json
{
  "warming": {
    "enabled": true,
    "ttlSec": 0,
    "minPromptTokens": 100000,
    "continueProbability": 0.2,
    "minSavingsUsd": 0.05,
    "maxDurationSec": 3600
  }
}
```

These are defaults. `ttlSec: 0` uses the model's `promptCache.short` or
`promptCache.long` (seconds), matching `PI_CACHE_RETENTION`; an unknown TTL skips
warming. An explicit positive `ttlSec` is for a known upstream lifetime.

Only Pi's bundled Anthropic models carry `promptCache` metadata, so a custom model
defined in `models.json` has no TTL and warming stays off until you set `ttlSec`
yourself. For GPT-5.6 and later families the relevant upstream control is
`prompt_cache_options.ttl`, whose only supported value is `30m` (also the default),
so `"ttlSec": 1800` matches what those models actually honour. Earlier OpenAI models
use `prompt_cache_retention` instead, where extended retention reaches 24 hours.
Note that the ledger makes a typical request far smaller than the 100000-token
`minPromptTokens` floor, so warming will rarely arm at the default setting. No cache
retention value is forced on requests. Other numeric fields must be finite and
nonnegative; probability is capped at 1.

After a successful consultation, while the executor is still running, a refresh
is considered at 90% of that TTL (at least 10 seconds before expiry). It replays
the exact advisor context and routing key with a 16-token output ceiling and no
automatic retry. A serialized payload fingerprint must match the original prompt
before dispatch. OpenAI Responses, OpenAI Completions and Anthropic Messages are
supported; Anthropic budgeted thinking is skipped when it cannot preserve the
prompt with the small output ceiling.

Expected savings = `continueProbability × promptTokens × (inputPrice − cacheReadPrice)
/ 1e6 − refreshCost`. Refreshing requires both positive savings and at least
`minSavingsUsd`. The configured probability is a tunable assumption, not a promise
that the executor will consult again. Both per-call and branch budgets must also
cover the estimated **cold** refresh, including a possible cache write. Background
refreshes never open confirmation dialogs. A cache miss, provider error or abort
stops the refresh chain.

Stopping the agent, starting another advisor consultation, opening `/advisor`,
changing model/effort, compacting, switching/forking/navigating sessions, or shutting
down cancels pending refreshes. An in-flight refresh is aborted and its reported
usage recorded before navigation completes. Tool inventory and model configuration
changes are checked again before dispatch. Refreshing ends at `maxDurationSec`
from the last actual consultation even if every refresh succeeds.

Paid warming requires the native `SessionManager.appendUsage` capability available
at runtime in Pi 0.86. The extension checks for it; older hosts skip warming. Usage
is recorded as `advisor-cache-warming`, without adding a conversation message, and
counts once in `/session`, the advisor status and the branch budget. The extension's
compatibility bridge keeps this runtime capability access isolated.

### `review`

```json
{
  "review": {
    "enabled": false,
    "minToolCalls": 1
  }
}
```

Completion review moves the "before declaring done" consultation into the
background. When a run settles on a final text answer, the advisor reviews the
delivered work while the executor and the user carry on; nobody waits on it. A run
is reviewed when it ended in a text answer with no tool call, did at least
`minToolCalls` executor tool calls (so pure chat is skipped), and the executor did
not already consult the advisor after its last tool call. Each final answer is
reviewed once, and only one review runs at a time.

The review closes the ledger with a review instruction instead of a question, and
the advisor answers with the same `Severity:` line as a consultation:

| Severity | Delivery |
| --- | --- |
| `none` | nothing is shown |
| `nit` / `concern` | a visible `advisor-review` card that enters the executor's context without starting a turn |
| `blocker` | the same card, and it starts a turn so the executor acts on it |

A blocker starts at most one turn per user prompt, so a fix the advisor still
rejects cannot loop. If the user has already started another run when the review
finishes, the card is held for the next prompt instead of being injected into the
unrelated run. An answer without a severity line is shown as a `nit`. A failed or
skipped review shows nothing. Later consultations replay a delivered review as the
advisor's own past answer.

A review is priced and gated like a consultation, including `timeoutSec`, but an
over-budget review is skipped rather than prompting. Its usage is recorded natively
as `advisor-completion-review`, so it counts in `/session`, the advisor status and the
branch budget; hosts without `SessionManager.appendUsage` never start one.
Compacting, switching, forking, navigating or shutting down cancels a review in
flight.

With review enabled, the executor's default guidance drops "call the advisor
before declaring done" and explains the review card instead. Custom
`guidance.promptGuidelines` are used as written.

### Measuring the result

From the `pi-advisor` package directory:

```sh
node scripts/advisor-usage-baseline.mjs --since=2026-09-28
```

Use the actual activation date (or an ISO timestamp) and `--sessions=DIR` for an
alternate session directory. The report includes consultation and warming costs,
skip reasons, retry/trim counts and estimated versus actual cost ratios. Old
transcripts that only stored the final retry remain a lower bound. Gateway routing
and cache hit improvements still need measurement against your actual provider.
