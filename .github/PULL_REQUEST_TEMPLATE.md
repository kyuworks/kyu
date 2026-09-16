## Summary

<!-- First sentence: what landed and why a reviewer should care. Then one bullet per change. -->

## Invariant

<!-- The rule about the bus that is now different. Run /must-hold to name it. Write "none" when no rule changed. -->

## Rollback

<!-- How to undo this change. Name the revert, and anything a revert does not undo (an outbox migration a consumer already applied, a published SDK version). -->

## How to check

<!-- A command or step the reviewer can run. For a behavior change, the test that failed without the production change. -->

Closes #

## Agent ship loop

<!-- Agents fill this. Humans delete this whole heading on a tiny PR (typo, docs-only, rename). -->

Behavior changed: yes | no
Red proof: `path/to/test.ts` (the test that failed before the change) | N/A

- [ ] Plan (call stacks if this adds or edits a publish path, handler, relay step, or webhook; otherwise N/A)
- [ ] Red must-hold (or N/A: docs / lint / rename / generated-only)
- [ ] Smallest diff
- [ ] `pnpm check:changed` (commit hook counts)
- [ ] Separate review (not the author)
- [ ] Hosted CI — do not claim done from a local green

## Out of scope

<!-- What this PR does not do. Omit the heading if nothing. -->
