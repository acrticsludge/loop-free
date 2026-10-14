---
description: Run a task through the loop-engine graph with evidence gates, a model ladder, and adversarial review.
agent: loop
model: opencode-go/longcat-2.5-preview-free
---

Hand off to the `loop` agent. Its contract in `agent/loop.md` is binding and
self-sufficient — this command adds nothing to it, so anything stated here would
be a second source for the same rule.

State the goal, the repo, and the acceptance criteria. Nothing else.

```
/loop <goal and acceptance criteria>
```

The orchestrator classifies the work, walks the 11 stages, and stops when its
failure law says to stop. It reports back in a fixed shape, so do not ask it for
a status update mid-run — read the portal instead, which is live and shows every
stage, gate and node as it happens.
