# Auto-update for `mira-channel` (MIR-231)

Tracks: [MIR-231](https://linear.app/miramira/issue/MIR-231/add-auto-update-plugin)

Status: design draft. Nothing implemented yet.

## Problem

Today the plugin only updates when a user manually re-installs the marketplace entry. The version pin in `plugins/mira/package.json` is hand-bumped, releases happen out-of-band with the Linear ticket flow, and end users have no signal that a newer build exists.

## Goal

Eliminate manual update toil. After install, the plugin should keep itself current with minimal user friction and a safe rollback path.

## Open questions

- What's the smallest possible auto-update surface? (Check-on-launch, periodic check, push?)
- Where does the version pin live (`package.json`, marketplace manifest, both)? Single source of truth?
- Who issues the rollback signal when a release goes bad?
- How do we sequence a tunnel-using plugin restart without dropping the open SSE stream?

## Proposed scope for this PR

1. Centralize the version constant.
2. Add a startup version-check that pings the marketplace manifest and logs the diff.
3. Surface "update available" as a `status_update` line.
4. Defer actual self-replace + restart to a follow-up — keep this PR observation-only.

## Out of scope

- Background silent updates.
- Semantic versioning enforcement.
- Multi-plugin orchestration (this repo only ships one).
