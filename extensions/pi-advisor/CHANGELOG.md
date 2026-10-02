# Changelog

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
