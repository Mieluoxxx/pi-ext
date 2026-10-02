# `advisor` tool reference

The exact surface rpiv-advisor registers: the tool's schema, its result envelope, what gets sent to the reviewer, and the rules that decide when the tool is visible to the executor model.

## Signature

```ts
advisor() // zero parameters
```

The parameter schema is an empty object. There is nothing for the executor model
to pass — the conversation branch is read live from the session manager at call
time and serialised automatically.

## What the reviewer receives

Each call assembles the request in this order:

1. **Tool catalogue prefix** — one synthetic message listing every tool registered
   in the executor's session (Pi's `getAllTools()`, i.e. the full registry, not the
   active subset), as `name — first sentence of its description`. The advisor judges
   tool *choice* and never invokes an executor tool, so the JSON schemas are omitted:
   they were pure cost, and because this block is the first thing in every request,
   a schema edit in any installed extension used to invalidate the whole cached
   prefix. Cached and rebuilt only when names or descriptions change.
2. **The executor ledger** — the branch compiled per entry, read from the raw
   session rather than Pi's resolved LLM context (the ledger needs entry IDs for its
   card handles, and it recovers the user's pre-compaction words that Pi's builder
   replaces with a summary).
   - Every user message, verbatim. Images are referenced, never embedded: a
     tool-produced image is named by its card so the advisor can `read` that path,
     while a terminal paste (which has no path in Pi's `ImageContent`) is reported as
     unviewable. Nothing embedded could be evicted from the prefix later, so nothing
     is embedded.
   - Older tool rounds as one-line cards: `#id tool · argument · status · size · ✗ error`.
   - The newest `ledger.tailToolCalls` rounds verbatim, plus the executor reasoning
     for the step that triggered this consultation.
   - Compaction and branch summaries labelled as Pi's paraphrase, with the user's
     literal words from that span re-stated ahead of them.
   - Extension messages hidden from the user, and `!!` shell runs excluded from the
     executor's own context, are withheld from the advisor too.
3. **Past consultations** — each completed consultation contributes the executor's
   question and, as the only assistant turns in the request, the advice that
   answered it. Failed, aborted and skipped consultations are omitted. The in-flight
   call's prose becomes the current question, and the request always ends on an
   instruction, never on a pending action.

Executor activity is always DATA inside a user-role `<executor_log>`; only the
advisor's own past advice takes the assistant role. Replaying executor turns as
assistant turns invited the reviewer to continue the transcript instead of
answering it, and to narrate the executor's work as its own.

Because each block is compiled from ONE entry, rendering a prefix of the branch
yields a prefix of the full render: consecutive consultations share a byte-identical
leading prefix, which is what provider prompt caching matches on. The verbatim tail
is the only part whose shape changes between calls, and it sits last. The request
uses `sessionId: "advisor:<Pi session ID>"` on both runtime and legacy dispatch
paths, including retries. No cache retention setting is forced.

Replayed over 1500 real consultations, this cut total prompt tokens by 89.5%
(385.2M to 40.5M; median request 183.7k to 21.3k tokens), with every user message
preserved and no request larger than the payload it replaced.

## Investigation tools

The advisor is invoked with the advisor system prompt, its own read-only tool
declarations, and the configured reasoning effort. Because older rounds arrive as
cards, it can retrieve the evidence itself:

| Tool | Answers |
| --- | --- |
| `advisor_expand({ids})` | what HAPPENED — the verbatim text behind a card |
| `read` / `grep` / `find` / `ls` | what IS — the workspace's current state, including an image at a path |
| `git_diff({path, patch, staged})` | the net change, `--stat` unless `patch: true` |

Rounds are bounded by `tools.maxRounds` and priced against the same per-call and
branch budgets as the first request. When the allowance runs out the declarations
are left unchanged — withdrawing them would rewrite the head of the cached prefix —
and the advisor is told in-band to answer with what it has. Investigation rounds are
never replayed into later consultations; only the final advice enters the ledger.

Paths must resolve inside the session cwd, and credential-shaped files are refused;
see [tools](./configuration.md#tools). No mutating tool is ever declared, so the
advisor cannot edit files, run commands, or write to your transcript — its answer
comes back only as the tool result the executor reads. The default prompt guidelines
direct the executor to restate the advisor's key guidance in its next visible reply,
so the guidance is not left only in a collapsed tool card.

While the call is in flight the executor streams
`Consulting advisor (<label>[, <effort>])…`, then one line per tool the advisor
opens.

## Result envelope

```ts
{
  content: [{ type: "text", text: string }], // reviewer's guidance, or an error message
  usage?: Usage,             // sum of all reported attempts; Pi 0.86+ session accounting
  details: {
    advisorModel?: string,   // "<provider>:<modelId>" — colon-joined
    effort?: ThinkingLevel,  // the reasoning level actually sent
    usage?: Usage,           // same aggregate, retained for older hosts
    attempts?: Array<{ usage?: Usage; stopReason: string; errorMessage?: string }>,
    estimate?: { promptTokens: number; cacheReadTokens: number; outputTokens: number;
                 costUsd: number; coldCostUsd: number; sessionUsd: number },
    request?: { hash: string; messageCount: number; estimatedTokens: number; timestamp: number; payloadHash?: string },
    skipped?: boolean,      // budget/context limit or same-model skip
    context?: { trimmed: boolean; anchorEntryId?: string; originalPromptTokens: number },
    stopReason?: StopReason, // pi-ai stop reason
    errorMessage?: string,   // populated on the no-model/auth/abort/error/empty paths
  }
}
```

`details.effort` is snapshotted once at entry, so it always matches the
`reasoning` value sent to the provider even if the selection changes mid-call.

Note that `details.advisorModel` uses the **colon** form (`provider:modelId`),
unlike the slash-form `modelKey` persisted in `advisor.json`.

## Failure paths

Every failure returns a normal tool result — the executor reads the text and
keeps going rather than crashing the turn.

| `content` text | `details.errorMessage` |
| --- | --- |
| `No advisor model is configured. The user can enable one with the /advisor command.` | `no advisor model selected` |
| `Advisor (<label>) is misconfigured: <err>` | the registry's auth error |
| `Advisor (<label>) has no API key available.` | `no API key for <provider>` |
| `Advisor call was cancelled before it completed.` | the provider's error message, or `aborted` |
| `Advisor call failed: <err>` | the provider's error message |
| `Advisor returned no text content.` | `empty response` |
| `Advisor call threw: <msg>` | the thrown message |

The budget gate can also return `Advisor skipped: …` with `details.skipped: true`.
The executor should continue without repeating that consultation. See
[budget configuration](./configuration.md#budget).

## When the tool is active

The tool is always **registered** — but it is stripped from the *active* tool
set, meaning the executor model cannot see it and its `promptSnippet` /
`promptGuidelines` drop out of the system prompt, whenever any of:

1. No advisor model is selected.
2. `modelKey` is absent, unparseable, or names a model that is no longer in Pi's
   registry at restore time. The stale in-memory selection is cleared too.
3. Advisor and executor have the same model ID, regardless of provider or effort.
4. The current **executor** model matches a `disabledForModels` entry — see
   [configuration.md](./configuration.md#disabledformodels).

This is what "off costs nothing" means: with no model configured, none of the
advisor's prompt text ever enters the system prompt.

## Lifecycle hooks

| Event | What happens |
| --- | --- |
| `session_start` | Reload `advisor.json`, re-apply model / effort / blocklist, activate or strip, announce once per process. |
| `before_agent_start` | Refresh advisor branch cost/cache status, then reconcile: blocked when no model is selected or the executor is blocklisted. |
| `model_select` | Re-reconcile on executor model change. Skipped for `source === "restore"` to avoid a duplicate notification. |
| `thinking_level_select` | Re-reconcile on reasoning-effort change and cancel warming. |
| `agent_start` / `agent_end` | Enable / cancel economic advisor cache refresh scheduling. |
| `session_before_compact` / `session_before_tree` / `session_before_switch` / `session_before_fork` / `session_shutdown` | Abort warming and finish recording its reported usage before the context changes. |

The three mid-session hooks route through a shared strip-or-add hub
(`reconcileAdvisorTool`). `session_start` uses that hub for the strip path and
adds the tool directly on the restore path.

## `/advisor` picker keys

Both pickers (model, then reasoning level) show up to 10 rows and share the hint
`type to filter • ↑↓ navigate • enter select • esc cancel`.

| Key | Effect |
| --- | --- |
| any printable character | appends to the fuzzy filter and rebuilds the list |
| Backspace | deletes one character from the filter |
| ↑ / ↓ | navigate; ↑ from the first row wraps to the last |
| Enter | select |
| Esc | cancel — the command exits without changing anything |

The filter scores against both the visible label (`Name  (provider)`) and the
underlying `provider/modelId` value, ranking contiguous runs and word-boundary
matches higher — so `op4` and `anthropic` both narrow the list.

`/advisor` requires an interactive TTY. Without one it notifies
`/advisor requires interactive mode` and returns.

## Host compatibility

The reviewer call uses pi-ai's `completeSimple`, which moved between
entrypoints across host versions: Pi ≥ 0.80.1 exports it from
`@earendil-works/pi-ai/compat`, and ≤ 0.79.x from the package root. Because
pi-ai resolves against the *host's* copy at runtime, the loader tries `/compat`
first and falls back to the root **only** on a module-resolution failure
(`ERR_PACKAGE_PATH_NOT_EXPORTED`, `ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`,
walked through the `cause` chain). Any other `/compat` error is rethrown so the
real failure surfaces instead of being masked.

If neither entrypoint exposes it, the call throws
`pi-ai does not expose completeSimple on /compat or the package root — unsupported host pi-ai version`.
