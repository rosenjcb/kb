# Eval question suites (YAML)

`--suite <name>` loads `eval/suites/<name>.yaml` (or `.yml`). `--suite` can also be a path to a YAML file.

Each file needs: `id`, `rubric_focus`, exactly **8** `questions`, and optionally `graph_with_base: false` (default true).

Disposable KB base names are **not** configured here — `eval-run.mjs` defaults `--base` to the run folder name (`<repo-leaf>-YYYY-MM-DD-HHmm`, same string as `~/.kb/evaluations/<that>/`). Override with `--base` if needed.
