# Changelog

## 0.3.0 — 2026-10-03

- Cap each consultation's wall-clock time with `budget.timeoutSec` (default 420s;
  time spent on a budget confirmation does not count). Across 1658 recorded
  consultations, failures held the executor 7.5 hours in total, and the slowest
  timeouts waited about 1000s each before the transport gave up; the cap returns
  `Advisor timed out after <n>s` instead. The default sits above the slowest
  successful consultation measured (p99 269s, max 547s).
- Re-send a failed request once when pi-ai classifies the error as transient, while
  less than half the time budget has elapsed. Deterministic failures such as a
  context-window overflow are still returned immediately; hosts without the
  classifier keep the previous no-retry behaviour.
- Open every advisor answer with `Severity: none|nit|concern|blocker`, accept
  `none` as a one-sentence answer, and add explicit lists of what to look for
  (premature completion, stubs standing in for implementation, guessing where a
  check could run) and what to stay out of (intent, scope size, unrequested
  backwards compatibility, errors the executor already saw).
- Add an opt-in background completion review (`review.enabled`). After a run settles
  on a final answer, the advisor reviews it without blocking; a `blocker` starts one
  executor turn, other findings land as a visible card, and `none` stays silent.
  Reviews are billed natively as `advisor-completion-review`, count toward the
  branch budget, and are replayed as past advice in later consultations. With review
  on, the default guidance stops asking for a blocking consultation before
  declaring done.

## 0.2.0 — 2026-09-29

- Compile the executor's branch into a ledger: older tool rounds become one-line
  cards, the newest rounds stay verbatim. Replayed over 1500 real consultations,
  total prompt tokens fell 89.5% (385.2M to 40.5M) with no request larger than the
  payload it replaced.
- Send every user message verbatim, including messages from before a compaction
  that Pi's resolved context replaces with its summary, and label that summary as a
  paraphrase.
- Reference images instead of embedding them. A tool-produced image is named by its
  card so the advisor can `read` that path on demand, delivered only to a
  vision-capable advisor model; a terminal paste has no path and is reported as
  unviewable. Count an image as a fixed 1200 tokens, matching Pi, rather than by the
  length of its base64 — measuring the encoded bytes overstated an attachment enough
  to make the trim logic discard history that cost nothing to keep.
- Keep executor activity in user-role logs and reserve the assistant role for the
  advisor's own past advice; always end a request on an instruction.
- Give the advisor a bounded read-only tool loop: `advisor_expand`, `read`, `grep`,
  `find`, `ls`, and `git_diff`, confined to the session cwd with credential-shaped
  files denied. Tool declarations stay unchanged when the round budget runs out.
- Replace the tool inventory's JSON schemas with one line per tool.
- Predict cache reuse from the append-only prefix only, so the re-rendered tail no
  longer prices every request as cold.
- Anchor a trim on the last dropped entry and shrink the verbatim tail when dropping
  cards alone cannot meet the context budget.
- Add `ledger` and `tools` configuration sections, and an offline replay script for
  comparing payload sizes against recorded sessions.

## 0.1.0 — 2026-09-28

- Extract advisor into a self-contained Pi extension with local configuration helpers, tests and usage reporting.
- Preserve the /advisor command, advisor tool and existing rpiv-advisor configuration.
- Keep stable request prefixes and session routing, aggregate all billed attempts, and enforce call/branch budgets.
- Persist context anchors for cold oversized requests and refresh large active-session prefixes only when economical.
- Disable consultations when advisor and executor have the same model ID.
