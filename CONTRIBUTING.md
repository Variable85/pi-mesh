# Contributing to pi-mesh

Thanks for helping! This project is small and focused — please read the
README first, then these guidelines.

## Project shape

- **Zero runtime dependencies.** Everything is plain Node (ESM, NodeNext).
  The only dependency is the Pi SDK (`@mariozechner/pi-tui`, dev/peer only,
  for the message renderers).
- **Layered**: `protocol/` (frames + validation) → `broker/` (server) →
  `client/` (MeshClient) → `extension/` (thin Pi adapter). The first three
  layers must never import Pi.
- **Honesty is a feature**: `delivered ≠ read ≠ answered`, statuses are
  never inflated, errors are explicit. Keep it that way.

## Design rules

- **One tool = one action.** Before adding a tool, check whether
  `mesh_send` + a convention covers the need. Deterministic needs
  (waiting, locking, checking) deserve tools; soft patterns (standby,
  naming) deserve conventions — never the other way around.
- **Every bound is a named constant** in `src/shared/config.ts`.
- **Comment the WHY, not the what.** No dev-tracking codes in comments;
  explain invariants in plain language.
- **Never persist message bodies** outside the opt-in transcript. The
  ledger stays hash-only; the forbidden-key scan is fail-closed.

## Development loop

```bash
npm install
npm run build       # strict tsc (ESM, NodeNext)
npm test            # build + node --test dist/test/*.test.js
npm run smoke       # E2E without Pi (broker + 2 headless clients)
```

- Tests run on Node 20 and Node 24 — the suite must pass on both
  (`npx -y node@24 scripts/run-tests.mjs`).
- Windows is a first-class platform (named pipes instead of AF_UNIX) —
  never break it.

## Releasing

Maintainers only: `npm version patch && git push && git push --tags`.
The `Release` GitHub Action runs the full suite and publishes
`pi-mesh-extension` to npm (requires the `NPM_TOKEN` secret).

## Reporting issues

Include: pi version, OS, `mesh doctor` output, and the exact tool call or
command that failed. Bugs about honest statuses (a status that overstates
delivery/read/answer) are always taken seriously.
