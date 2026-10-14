---
description: Run a task through the free-tier loop graph. Same 11 stages and same gates as /loop, every node on a zero-cost model.
agent: loop-free
model: opencode-go/longcat-2.5-preview-free
---

The `loop-free` agent is a zero-cost variant of `loop`: identical pipeline,
identical gates, identical failure law, different model table. Its contract in
`agent/loop-free.md` is binding and self-sufficient, so nothing needs repeating
here.

State the goal, the repo, and the acceptance criteria. Nothing else.

```
/loop-free <goal and acceptance criteria>
```

Read progress from the portal rather than asking for status mid-run; it is live
and shows every stage, gate and node as it happens.

**Before you pick this over `/loop`:** free models are weaker. Expect more
implementation attempts and shallower review. A blocked review from a free model
is a correct outcome and the run will stop on it. If the work touches auth,
payments, migrations or anything where a wrong `ship` is expensive, use `/loop`
and pay for it.
