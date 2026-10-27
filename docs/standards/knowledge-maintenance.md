# Maintaining reusable project knowledge

- Status: Accepted project workflow.
- Scope: Every contributor and coding agent, regardless of tool or machine.
- Intent: Future work should benefit from verified decisions and user corrections without
  requiring this chat's history. Repository instructions provide context; they do not train
  a model or guarantee that every client loads the files automatically.

## When to capture a rule

During the same task/PR, preserve a finding when it is likely to affect another feature,
contributor, or future iteration. Typical triggers are:

- A user corrects a recurring assumption or states a durable product/design preference.
- A component/API integration has a non-obvious requirement, version difference, or trap.
- A repeated defect reveals a reusable boundary, validation rule, or review check.
- A workflow decision changes how agents build, verify, review, or merge work.

Use judgment. Do not record ordinary implementation narration, temporary ports, one-off
logs, every bug fix, or guesses as new policy. Secrets, personal machine paths, and local
agent memory are never shared engineering knowledge.

## Where knowledge belongs

| Kind                                                                            | Canonical home                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------- |
| Project orientation, reading routes, and the source/document map                | [Root project entry point](../../start-here.md)     |
| Short cross-cutting instruction or routing rule                                 | Root `AGENTS.md`                                    |
| Folder-specific entry point                                                     | A scoped `AGENTS.md` linking the canonical standard |
| Reusable design/engineering practice                                            | `docs/standards/` with an entry in its index        |
| Architectural choice, public contract, design-system choice, or major exception | `docs/decisions/NNNN-short-title.md`                |
| Setup and contribution commands                                                 | `CONTRIBUTING.md`                                   |
| Merge, CI, release, deployment behavior                                         | `docs/ci-cd.md`                                     |
| What is implemented and what remains proposed                                   | Relevant feature/architecture document              |

Prefer updating an existing canonical section. Tool-specific `CLAUDE.md`, Cursor, and
Copilot files are loaders; do not duplicate the full rule in every tool. Keep root guidance
short enough to read and put detailed examples in the domain standard. A new vendor-specific
skill is unnecessary for a rule that can be shared through the repository.

The root entry point is the shared first-session map. When changing source layout, canonical
document locations, or implementation status, update its affected references and summaries in
the same change. Keep detailed rules in their existing homes rather than copying them into
the entry point.

## Evidence and status

Each durable rule must make these points clear (a short paragraph or table is sufficient):

1. **Scope and trigger:** which tasks it applies to and what problem it prevents.
2. **Status:** accepted project rule, verified upstream fact, proposed/unverified, or
   superseded. Accepted policy and completed implementation are separate claims.
3. **Evidence:** the user decision, an ADR, a reproducible code/test result, or an official
   source with a version/date. Summarize decisions; do not export private chat transcripts.
4. **Action:** the concrete behavior to follow, with a small example when useful.
5. **Verification:** how to check compliance and what the current automation cannot prove.
6. **Revisit condition:** an upgrade, implementation milestone, or evidence that invalidates
   the rule. Update or supersede stale guidance rather than accumulating contradictions.

Do not promote speculation into a binding requirement. If a gap can be resolved by reading
official docs, inspecting the pinned package, or running a bounded check, do that work first.
If it remains uncertain, record the uncertainty and next verification step. Do not declare a
package unavailable solely because the initial project did not include it.

## Update workflow

1. Identify the smallest reusable lesson while implementing or reviewing the task.
2. Locate the existing standard and search related docs for contradictory wording.
3. Verify the source, version, and applicability. Prefer primary sources for external APIs.
4. Update the canonical rule and any affected implementation-status claims. Add an ADR only
   when the decision merits one; avoid a new document for every minor detail.
5. Link the rule from the standards index and the relevant agent entry point. Mention the
   update in the PR's Reusable knowledge section, or say why no reusable rule changed.
6. Run the normal quality gate, review the diff, and follow the current merge policy.
   Add automation for meaningful repeatable checks, without pretending prose presence proves
   semantic compliance. Do not add tests that merely mirror a reversible documentation edit.

At handoff, point to the updated canonical file and distinguish implemented behavior from
accepted guidance. Future agents should read applicable standards before choosing an approach
and revisit the relevant rule when discovering contradictory evidence.

## Examples from this project

- **TiUI correction:** visual similarity and a red logo were insufficient. The accepted rule
  requires actual TiUI components/provider. The migration now supplies that integration;
  versioned compatibility and style-composition findings are recorded in its standard.
  See [TiUI standard](tiui-design-system.md) and [ADR 0002](../decisions/0002-tiui-design-system.md).
- **Readability:** the owner requested larger text and less crowding. Keep those targets as
  project overrides, separate from upstream typography defaults.
- **Single Key:** one customer credential combines resource and action permissions; upstream
  keys remain internal. [ADR 0001](../decisions/0001-unified-workspace-key.md) and API tests
  capture the boundary instead of relying on a UI checkbox.
- **Early iteration:** reviewed, signed, green task-scoped PRs can be merged without another
  confirmation. The [CI/CD policy](../ci-cd.md) records the phase and limits of that authority.
