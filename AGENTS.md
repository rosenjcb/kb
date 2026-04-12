# AGENTS

Repository-level operating rules for coding agents in this workspace.

## Always-On Dogfood Requirement

For all meaningful development work, agents must document decisions and outcomes in the KB using the CLI.

This is mandatory and does not depend on skill invocation.

## Required Agent Workflow

1. Ensure fresh CLI access before significant work:
   - npm run refresh:global
   - npm run which:kb
2. Use KB docs during execution, not only at the end.
3. Keep test data isolated from persistent docs:
   - Persistent work: set KB_NAMESPACE=dogfood
   - Disposable automation: KB_NAMESPACE=ci-* or KB_NAMESPACE=test-*
4. Treat persistence as part of completion:
   - git add sessions/
   - git commit -m "kb: checkpoint knowledge base"
   - git push

## Open-Question Gate (Mandatory)

When a ticket implementation plan contains any unresolved/open question, the agent must explicitly ask the user for a decision before closing the ticket.

Allowed outcomes before closure:

1. User provides a decision and the ticket is updated accordingly.
2. User explicitly approves deferral with a time-box and follow-up ticket reference.

If neither happened, do not mark the ticket closed.

When practical, ask unresolved decisions as multiple-choice prompts:

1. Present 2-5 concrete options.
2. Mark one recommended default.
3. Allow user freeform override.

This is preferred for speed, consistency, and easier agent handoff.

## CLI Fallback

If global kb is unavailable in the environment:

- npm run build:cli
- node dist/bin/kb.js "What tools are available?"

## Storage Intent

- Dogfood docs are expected to be durable and Git-tracked.
- CI/test namespaces are disposable and should not pollute persistent KB context.

## Enforcement Intent

If a task is completed without KB documentation for significant architectural, behavioral, or process changes, the task should be considered incomplete until KB docs are updated.
