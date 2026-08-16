---
"@kb/core": major
---

`createEmbedder()` is strict now: it returns an `Embedder` (never `undefined`) and throws on misconfiguration instead of silently degrading. `KB_EMBEDDER` unset/`local`/`onnx` selects Local ONNX; `gemini` requires `GEMINI_API_KEY` or throws; any other value throws — a present `GEMINI_API_KEY` no longer auto-selects Gemini when `KB_EMBEDDER` is unset, so the backend is always an explicit choice. `SqliteKbIndexer#embedAll`/`embedAllDocuments`/`embedAllCodeSymbols`/`embedAllFacts` now throw when no embedder is attached instead of silently no-opping, and `scanBaseRepos`'s trailing embed step now propagates failures instead of swallowing them. `kb init`'s cold embed step and query-time embedding (`FactsDocumentReader`) keep their existing best-effort/hard-fail split via `requireEmbeddings/requireEmbedderForInit` vs. a local catch.

Also lands the Fly builder/serving config this depended on: `fly.toml` and `fly.builder.toml` now declare `KB_EMBEDDER = "gemini"`, `scripts/fly/deploy.sh` passes `-e KB_EMBEDDER=gemini` on every `fly machine run`, and `scripts/fly/refresh.sh` gained `FORCE_COLD=true` (bypass the warm path) and fail-fast semantics (a failed base aborts the run and skips the serving roll instead of continuing to the next base).
