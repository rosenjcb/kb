`eval-run.mjs` and the kb suite YAML coordinate LLM provider selection and auto-scoring through
a shared `rubric_focus` field and environment-variable-based provider selection.

The suite YAML (`eval/suites/*.yaml`) defines a `rubric_focus` string (e.g., "the **kb** local-first
knowledge CLI/repo") that is injected verbatim into the system prompt sent to the scoring LLM. This
string contextualizes the evaluator and tells it what kind of correctness to assess. It is loaded
by `eval-run.mjs` as part of the suite object and passed directly to `runAutoScoreFile()`.

`runAutoScoreFile()` handles provider selection at runtime: if `GEMINI_API_KEY` is set in the
environment, it uses Gemini (model: `gemini-2.5-flash`) as the primary scorer. If Gemini is not
available but `OPENAI_API_KEY` is set, it falls back to OpenAI (model: `gpt-4o`). The flag
`--manual-score` (parsed as `autoScore: false`) skips the entire scoring step.

All 8 Q&A pairs from the current run are assembled into a single batch and sent in one LLM call.
The response is parsed as a JSON object with per-question scores on four axes: `correctness`,
`usefulness`, `specificity`, and `evidence_handling` (each 0–4). Scores are written to
`auto-scores.json` in the run directory and merged into `artifact.json` under `query_evaluation`.

The query LLM (which answers questions during `kb query`) and the scoring LLM (which grades those
answers) are configured independently — the query provider is determined by the `~/.kb/config.json`
LLM settings, while the scoring provider is determined solely by environment variables at eval time.
