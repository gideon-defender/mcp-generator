# Phase 0 audit outputs

Generated `report.json` / `report.md` files in subdirectories here are local
artifacts (git-ignored). Regenerate them from the repository root:

```sh
pnpm build
node dist/cli.js audit --spec ../opencomp/packages/docs/openapi.json --out audits/opencomp
node dist/cli.js audit --spec ../auth/openapi.yaml --out audits/gideon-auth
node dist/cli.js audit --spec ../auth/openapi.yaml --docs ../identity-cockpit/docs/api-routes.md --out audits/gideon-auth-with-cockpit-docs
node dist/cli.js audit --spec ../agent-communications/openapi.yaml --out audits/agent-communications
node dist/cli.js audit --spec ../message-delivery/openapi.yaml --out audits/message-delivery
```

Expected operation counts (regression anchors): OpenComp 420, Gideon Auth
691, Agent Communications 169, Message Delivery 23.

## Keeping these in sync with the generator

Because these reports are git-ignored, nothing flags it when a generator
change (a new finding, a revised rule) leaves a checked-in report stale.
`pnpm audit:check-drift` re-runs the audit behind every `audits/*/report.json`
it finds and fails if the fresh result no longer matches the file on disk.
It takes no configuration: each report already records the absolute spec
(and docs) path it was generated from, so the check needs no sibling
project — any entry whose spec isn't checked out on the current machine is
skipped, not failed. It isn't run in CI (a fresh checkout has no
`report.json` files to check, since they're git-ignored, so the step would
always be a no-op there); run it locally — and regenerate any report it
flags — before committing a change that alters audit output.
