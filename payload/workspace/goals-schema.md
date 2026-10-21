# Goals System Schema

Reference spec for the YAML-based OKR/goals system. Used by the `goals-onboarding` agent to generate files for new companies/workspaces.

## Hierarchy

```
Annual Objective (T#)
  └─ Key Result (T#-#) — measurable target
  └─ Initiative (I#) — project to achieve the objective
       └─ Task (I#-T#) — specific work item

Team Quarterly OKR (E-Q#-##)
  └─ Key Result (E-Q#-##-KR#) — with weekly tracking

Support Function (S#) — operational enabler, not a strategic objective
```

## ID Conventions

| Level | Pattern | Example |
|-------|---------|---------|
| Annual Objective | `T#` | T1, T2, T3 |
| Key Result (annual) | `T#-#` | T1-1, T1-2 |
| Team Quarterly Obj | `{Team Initial}-Q#-##` | E-Q1-01 |
| Team KR | `{Team}-Q#-##-KR#` | E-Q1-01-KR1 |
| Initiative | `I#` | I0, I1, I12 |
| Task | `I#-T#` | I0-T1, I12-T3 |
| Support Function | `S#` | S1, S2 |

## File Structure

```
{project}/goals/
  {company}-{year}-annual.yaml          # Annual objectives + KRs + support functions
  {company}-{year}-Q{n}-{team}.yaml     # Team quarterly OKRs (one per team per quarter)
  {company}-{year}-initiatives.yaml     # All initiatives + tasks
  org-chart.yaml                        # Team roster
  tasks-inbox.md                        # Actionable items not yet tied to an initiative
  maintenance-tasks.md                  # Outstanding review items
```

## YAML Schemas

### Annual File

```yaml
company: string              # Company name
period: "YYYY"                # Year
type: annual
total_revenue_target: number  # Optional — sum of revenue objectives

objectives:
  - id: T#
    name: string              # Objective statement
    owner: string             # Person responsible
    target: number            # Optional — numeric target
    unit: string              # Optional — USD, count, etc.
    type: string              # Optional — "prerequisite" for T0-type items
    status: null | on-track | at-risk | off-track | complete
    teams: [string]           # Optional — which teams have quarterly breakdowns
    notes: string             # Optional

    key_results:              # Optional — measurable outcomes
      - id: T#-#
        description: string
        target: number
        unit: string

# Operational enablers (not strategic objectives)
support_functions:
  - id: S#
    name: string
    owner: string
    status: not-started | in-progress | done
    notes: string

# Archive of completed support items
completed_support:
  - name: string
    completed: YYYY-MM
    notes: string             # Optional
```

### Team Quarterly File

```yaml
company: string
team: string                  # Team name (e.g., Ecom)
period: "YYYY-Q#"
type: quarterly
owner: string                 # Team lead
parent_objectives: [T#]       # Which annual objectives this team serves

objectives:
  - id: {Team}-Q#-##
    name: string
    owner: string
    parent: T#                # Link to annual objective
    status: null | on-track | at-risk | off-track | complete

    key_results:
      - id: {Team}-Q#-##-KR#
        description: string
        target: number
        unit: string          # USD, ratio, percent, count
        tracking:             # Weekly actuals — dated entries
          YYYY-MM-DD: number | null
          YYYY-MM-DD: number | null

    initiatives: []           # Optional — can reference I# from initiatives file
```

### Initiatives File

```yaml
company: string
period: "YYYY"
type: initiatives
last_updated: YYYY-MM-DD

initiatives:
  - id: I#
    name: string
    parent: T# | T#-# | support    # Links to objective, KR, or support
    owner: string
    start_date: YYYY-MM-DD
    end_date: YYYY-MM-DD
    revised_end_date: YYYY-MM-DD | null   # Added when original end_date passes
    status: done | in-progress | not-started

    tasks:
      - id: I#-T#
        description: string
        owner: string
        start_date: YYYY-MM-DD          # Optional
        end_date: YYYY-MM-DD            # Optional
        revised_end_date: YYYY-MM-DD | null   # If past due
        status: done | in-progress | not-started
        notes: string                   # Optional
```

### Org Chart File

```yaml
company: string
last_updated: YYYY-MM-DD
type: org-chart

team:
  - name: string
    role: string              # Job title / function
    areas: [T#, S#]           # Which objectives/functions they own
    notes: string             # Optional
```

## Status Values

| Context | Values |
|---------|--------|
| Objectives & KRs | `null` (not yet assessed), `on-track`, `at-risk`, `off-track`, `complete` |
| Initiatives & Tasks | `done`, `in-progress`, `not-started` |
| Support Functions | `not-started`, `in-progress`, `done` |

## Weekly Review Process

1. Pull all YAML files for the company
2. For each quarterly KR: update `tracking` with this week's actual
3. For each initiative/task: update status, add `revised_end_date` if past due
4. Flag any KR where actual < expected trajectory → mark objective `at-risk`
5. For `at-risk` or `off-track` items: add troubleshooting notes
6. Generate dashboard / export if needed

## Export Formats

The YAML can be transformed into:
- **CSV** — for spreadsheet / investor reports (Objective | Owner | Target | Actual | % | Status | Weekly columns)
- **Markdown dashboard** — for quick review in workspace
- **Filtered views** — by team, by status, by owner

## What Belongs Where

| Item Type | Where It Goes |
|-----------|--------------|
| Revenue / growth targets | Annual objectives (T#) with KRs |
| "Build X", "Launch Y" | Initiatives (I#) under the relevant objective |
| Specific action items | Tasks (I#-T#) under the initiative |
| MCP integrations, workspace tooling | Support functions (S#) or `workspace-upgrades.md` |
| Team-specific quarterly targets | Team quarterly file |
| Completed one-off items | `completed_support` in annual file |

## Anti-Patterns

- **Don't mix workspace tasks into business objectives** — MCP integrations, agent development, log systems stay in `Workspace Development/` or equivalent
- **Don't auto-generate goals** — agents should never create objectives or KRs. Only the user defines those.
- **Don't use arbitrary percentages** — use status values (on-track/at-risk/off-track) and actual vs target numbers
- **Don't skip IDs** — every objective, KR, initiative, and task needs an ID for cross-referencing
