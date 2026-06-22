---
"kb": patch
---

Add `GEMINI_API_BASE_URL` for WireMock-backed integration tests; docker-compose runs an `llm-mock` sidecar so CI needs no real LLM API key.
