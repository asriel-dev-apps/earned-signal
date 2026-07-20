# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues. Use the `gh` CLI from this clone so the repository is inferred from `origin`.

## Conventions

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <number> --comments`.
- List: `gh issue list --state open --json number,title,body,labels,assignees`.
- Comment: `gh issue comment <number> --body-file <path>`.
- Label: `gh issue edit <number> --add-label "..."`.
- Close: `gh issue close <number> --comment "..."`.
- Pull requests are not used as a request surface.

## Wayfinding operations

- The implementation map is one issue labelled `wayfinder:map`.
- Child tickets use `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Prefer GitHub sub-issues and native issue dependencies. If either API is unavailable, list children as task-list entries in the map and record `Blocked by: #...` in ticket bodies.
- Claim a ticket before work with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting with the evidence, closing the ticket, and adding a one-line link to the map's Decisions-so-far section.
- The execution override in the VECTA map requires task tickets to include implementation, verification, security scan, and push—not decision-only output.
