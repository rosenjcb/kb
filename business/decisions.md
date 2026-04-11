# Business Decisions Log

This file documents strategic and business-level decisions that guide the agent's behavior.

## Decision Framework

- **Permission Model**: Role-based + pattern-based denials
- **Tool Availability**: Declared in `permissions.yaml`
- **Audit Trail**: All decisions logged to `decisions.jsonl`

## Key Decisions

### 1. Streaming Event Model
- Agent yields events as they occur (not batch)
- Enables real-time UI updates and monitoring
- Allows interruption between tool calls

### 2. Provider Abstraction
- Support any LLM (Claude, GPT, Gemini, Ollama)
- Normalize all responses to common format
- Swap providers via config, not code changes

### 3. Business Logic in Config
- Tool permissions live in YAML (not hardcoded)
- Role-based access control
- Pattern-based denial rules

### 4. Decision Audit Trail
- Every permission decision logged to `decisions.jsonl`
- Timestamp + context + rationale
- Enables compliance review and debugging
