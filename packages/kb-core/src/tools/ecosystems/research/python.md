# Python ecosystem research

Date: 2026-07-28 · Coverage: `../python.yaml` (`status: planned`)

## Tooling verdict

- **uv won.** Astral’s uv is the active project/package manager; workspaces live in
  root `pyproject.toml` as `[tool.uv.workspace]` with `members` / optional
  `exclude` globs; shared `uv.lock`.
- **Rye is dead.** Rye is no longer developed (repo archived; maintainers point
  users at uv). **Do not elevate Rye** in YAML, kind rules, or workspace
  sources. Mention only as historical → migrate-to-uv.
- **Poetry / PDM** remain real but secondary. PDM workspaces:
  `[tool.pdm.workspace]` + `members`. Poetry has **no** first-class workspace
  table comparable to uv/PDM; monorepos are path deps / multiple
  `pyproject.toml` trees — do not invent a Poetry workspace source.
- **Primary manifest: `pyproject.toml` (PEP 621 `[project]`)**. Fall back to
  Poetry-table identity (`[tool.poetry].name`) when PEP 621 absent. Then
  `setup.cfg` / `setup.py`. `requirements*.txt` is **deps-only** — never sole
  identity for an entity.

## Parsing (implementation note — not in YAML)

When the Python harvester is wired, parse TOML with **`smol-toml`** (small,
TOML 1.x, widely used on npm; already the practical default for Node-side
`pyproject.toml` readers). Do not add a Python runtime for manifest harvest.
`setup.py` remains best-effort / skip if dynamic; prefer static metadata.

## Kind rubric notes

| Signal | Maps to TS analogue |
|--------|---------------------|
| `[project].scripts` / `gui-scripts` / Poetry scripts / setuptools `console_scripts` | `has_bin` |
| Named project + package discovery / build-system | `has_entry` |
| Dep on fastapi/django/flask/… | `any_dependency_group: server` → service |
| Dep on streamlit/dash/gradio/… | `frontend` → surface |
| Dep on click/typer/fire/… | `cli` (weaker than scripts) |
| `argparse` | stdlib — no dep signal; out of manifest harvest |

Avoid obsolete web stacks as **primary** framework list (bottle, cherrypy,
web.py, cgi). Keep tornado/aiohttp/sanic/quart as still-seen ASGI/WSGI options.

## Routes (tier-4, optional)

`routes.status: not_implemented`. Planned enrichment order:

1. **FastAPI** — `@app.get/post/...` / `APIRouter` path ops
2. **Django** — `urls.py` / `path()` / `re_path()` URLConf
3. Flask / Starlette / Litestar — decorator or route-table patterns

Never load-bearing; missing parsers only lose endpoint granularity
([ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) §4a).

## Out of scope for this YAML

- Runtime inference / loader changes (`ecosystem-config.ts`, harvesters)
- Promoting tree-sitter symbols to entities
- Lockfiles as identity (`uv.lock`, `poetry.lock`, `pdm.lock`)
- Hatch/Pixi/Conda as first-class workspace sources (revisit if needed)
