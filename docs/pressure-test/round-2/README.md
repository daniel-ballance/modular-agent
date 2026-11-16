# Pressure test, round 2

**Started:** 2026-11-16. **Status:** running.

**Question:** do the revised docs hold up? Round 1 ([synthesis](../synthesis.md)) found 12 of 32 assumptions false, and changes 1–10 were applied in commit `94d9d21`. Round 2 checks whether those changes fixed what they were meant to fix, and looks for what they broke or missed.

**Method:** the same four rungs as [round 1](../README.md#the-ladder), with fresh reviewers. Each rung is reviewed by the other model family this time, so no reviewer checks its own earlier report.

| Rung | Target | Reviewer | Report |
|---|---|---|---|
| 1 | Pi and pi-packages | Grok 4.7 | [rung-1-pi.md](rung-1-pi.md) |
| 2 | DeepSeek Harness, Pydantic AI | GPT-6 Astra | [rung-2-frameworks.md](rung-2-frameworks.md) |
| 3 | Several agents (T3 Code), driven from outside | GPT-6 Astra | [rung-3-multi-agent.md](rung-3-multi-agent.md) |
| 4 | Everything at once, and a red team | Grok 4.7 | [rung-4-maximal.md](rung-4-maximal.md) |

Each reviewer does three things:
1. **Rechecks round 1.** For every finding in its rung's round-1 report, it says whether the revised docs resolve it: *resolved*, *partly*, *not resolved*, or *rejected* (the finding was wrong).
2. **Tests the revised claims.** It gives a verdict on each of the ten guarantees in [Architecture](../../architecture.md#guarantees) and on each of the synthesis's ten changes, using the round-1 scale: *holds*, *strains*, *gap*, *breaks*.
3. **Looks for new failures,** especially ones the changes introduced: in actors and authority, exchanges, jobs, stateful Providers, history rules, the output gate, declarations, and being driven by a host. It also checks that the docs still describe *what*, not *how*, and that they agree with each other.

Findings use the same fields as round 1 ([README](../README.md#what-each-finding-records)).

**Success** is no guarantee or change judged *breaks*, and every round-1 finding *resolved*, *rejected*, or recorded as an open question.
