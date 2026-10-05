# ZCode

T3 Code can run threads on your existing `zcode` CLI installation, keeping ZCode's own models,
sign-in, hooks, plugins, and MCP servers.

## Set Up ZCode

1. Install the `zcode` CLI on the machine running the T3 Code server and sign it in (`zcode login`,
   or your usual provider configuration).
2. Open T3 Code Settings, add a provider instance, and choose ZCode.
3. If `zcode` is not on the server's `PATH`, set its binary path.

New instances start with the `ZCode default` model, which keeps whatever model ZCode's settings
select. The models ZCode makes available appear after you start a thread or refresh models in
Settings. Models with reasoning levels show a Reasoning picker.

## Permission Modes

- **Supervised** runs ZCode's `build` mode. Tools ZCode considers risky ask for approval in T3 Code.
- **Auto-accept edits** runs ZCode's `edit` mode.
- **Full access** runs ZCode's `yolo` mode and approves any remaining requests.

"Allow for this session" lasts for the T3 Code provider session. It does not add ZCode's
project-wide "always allow" rule.

## Limits

ZCode threads cannot roll back or fork their conversation, and a message sent while ZCode is
working waits for the current turn to finish. ZCode instances do not generate commit messages,
pull request text, or thread titles.

## Troubleshooting

- If ZCode is unavailable, confirm that `zcode version` runs on the server machine, then refresh
  the provider in Settings.
- T3 Code infers sign-in from the files ZCode writes. An expired sign-in only shows up when a turn
  fails; sign in again with `zcode login`.
