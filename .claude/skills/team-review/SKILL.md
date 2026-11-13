---
name: team-review
description: Whole-project health review where every specialist audits its own area and the architect reconciles the results. Invoke with /team-review [focus].
disable-model-invocation: true
---

Run a whole-project review. Focus, if given: $ARGUMENTS

1. In parallel, ask frontend-engineer, backend-engineer, data-engineer, test-engineer, ci-engineer, sre and security-reviewer to review their own area against the standards in their definition. They must not change any files. Each returns findings ranked by impact on the whole product, with locations.
2. Give all the reports to the architect and ask for one prioritized list that merges duplicates and groups issues spanning several areas, each with an owning agent.
3. Present the list to the owner and ask which items to fix. Fix approved items using the /feature workflow's ordering.
