# Lessons

- Partial clones append `[<filter>]` to `git remote -v` fetch lines. Repository identity parsing must allow that suffix; a missing identity splits repository groups and prevents automatic scheduling across those project copies. Reproduce with real Git promisor/filter configuration.
