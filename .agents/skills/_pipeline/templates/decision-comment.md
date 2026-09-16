# Decision comment

Posted on the feature issue when an unattended run passes a gate without Matt. One
comment per gate. Same information the attended gate would have shown Matt, so the
reader can overturn it with the same knowledge.

Write it in ISO 24495-1 plain language — invoke the `iso-24495` skill.

```markdown
## Decision: {gate — tier | research | plan | single-PR collapse}

**Chosen:** {the option, in one line}

**Options**

| Option | Taken? | Why not |
|---|---|---|
| {A} | yes | — |
| {B} | no | {one line} |
| {C} | no | {one line} |

**Reasoning**

{Two to four short sentences. Name the rule it followed — the tier rubric row, the
plan's riskiest flow, the pr-decomposition strategy. Say what would have changed the
answer.}

**Unattended run** `{session or run id}`, {date}. Reply here to overturn; the next
`/next` reads this thread before it acts.
```

For the plan gate, add the four things the attended gate shows:

```markdown
**Behaviour** — {one sentence}
**Non-goals** — {list}
**Flow inventory** — {count}; riskiest: {three rows}
**PR shape** — {how many, and why more than one if so}
```
