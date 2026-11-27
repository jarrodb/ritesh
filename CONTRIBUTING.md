# Contributing

## Setup

Node 24 and Go 1.25 or newer.

```sh
npm ci
npm run build
npm test
(cd server && go test -race ./...)
```

## Rules

- `docs/language.md` defines the language and `docs/protocol.md` the wire protocol. Change them first, with cases in `docs/language/cases.jsonl` or traces in `protocol/traces/`, then the code.
- `packages/ritesh/src/contracts.ts` is the boundary between modules. A change to it is a design change; say why in the PR.
- After editing `protocol/rite.1.schema.json`, run `npm run sync:protocol`.
- Every user-visible change needs a changeset: `npx changeset`.
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`).
- Before a PR: `npm run lint`, `npm test`, `npm run build`, `npm run check:package`, and the Go checks.
