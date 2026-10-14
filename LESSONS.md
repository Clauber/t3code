# Lessons

- Partial clones append `[<filter>]` to `git remote -v` fetch lines. Repository identity parsing must allow that suffix; a missing identity splits repository groups and prevents automatic scheduling across those project copies. Reproduce with real Git promisor/filter configuration.
- Fork CLI archives built on GX10 need `VP_NODE_VERSION=26.8.2` for `build-exe` (vite-plus defaults to Node 24, which rejects tsdown's exe option) and `scripts/update-release-package-versions.ts <version>` first, or the smoke test fails with `t3 v0.0.45`.
- The Browser panel runs on the client, not the server host: a worktree dev server is only reachable through a LAN address, which needs `T3CODE_DEV_ALLOWED_HOSTS=<ip>` and a forwarder to Vite's loopback port.
