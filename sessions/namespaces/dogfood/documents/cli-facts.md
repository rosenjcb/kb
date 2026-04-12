# cli facts

Created: 2026-04-12T16:08:52.929Z
Type: reference
Tags: cli, fact

- KB base precedence order: 1) session base set by kb use, 2) default base set by kb default, 3) KB_BASE environment fallback. (source: README)

- Correction (2026-04-12 code audit): KB_BASE does not override session/default config in current CLI behavior; for deterministic dogfood routing use 'kb use dogfood' (or clear session/default config) before intent commands. (source: code-audit)
