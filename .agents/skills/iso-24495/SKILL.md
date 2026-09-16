---
name: iso-24495
description: >
  Write GitHub issues and pull requests in plain language.
  Use when creating or editing an issue or PR.
---

# Plain language — issues and PRs

Simple words. Assume the reader has no context. First sentence is the ask or the change. Avoid metaphors and filler: spine, reticulate, journey, leverage, utilize, going forward.

## Issue

```markdown
## What
{Who this is for. What they must do. When it is done.}

## Do not
- {Out of scope.}

## Acceptance
1. {Testable result.}
```

**Title:** what must be true when it is done. No ticket IDs.

## PR

```markdown
## Summary
{What landed and why a reviewer should care.}

- {One change. One idea.}

## How to check
- {Command or click.}

## Out of scope
- {Omit this heading if nothing.}
```

**Title:** imperative, under 70 characters, no issue number, outcome not journey.

Keep `Closes #N` when an issue exists. Keep product names and file paths exact.
