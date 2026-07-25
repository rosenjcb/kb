---
"@kb/server": patch
---

`kb-server refresh`'s throwaway bootstrap child (#195) no longer discards its stdout/stderr — it's now redirected to a log file under the daemon's `logDir()` (`refresh-bootstrap.<base>.log`, same pattern as `kb-server start --daemon`) instead of `stdio: 'ignore'`. A cold index of a large repo can run for a long time with no other visibility into per-file progress; `--json` output stays unaffected since the child's output never touches the parent's own stdout.
