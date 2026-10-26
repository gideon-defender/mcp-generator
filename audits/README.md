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
