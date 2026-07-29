# Ruby ecosystem harvest — research note

**Status:** coverage YAML declared (`ruby.yaml`); inference not wired.

## Manifests

| Signal | Role | Entity atom |
|---|---|---|
| `*.gemspec` | Primary package | `Gem::Specification#name`; gloss from `summary` / `description` |
| `Gemfile` | App root + workspace cue | Solo Rails apps often have **Gemfile only** (no gemspec) — identity from dir basename or `config/application.rb` module |
| `Gemfile` `gem "x", path:` | Member discovery | Path gems / in-repo engines → separate gemspec atoms + `part_of` host |
| `gemspec` method in Gemfile | Dev wiring | Pulls runtime deps from gemspec; not a second entity |
| `Gemfile.lock` | Lock only | Never an entity |

No Cargo/pnpm-style workspace table. Monorepos = path gems under
`engines/*`, `gems/*`, `components/*` plus host `Gemfile`.

**Rails engines** ([guides](https://guides.rubyonrails.org/engines.html)): gemspec
+ `lib/<name>/engine.rb` (`Rails::Engine`, often `isolate_namespace`). Host
declares `gem "blorgh", path: "engines/blorgh"`. Engine deps belong in the
**gemspec**, not the engine’s Gemfile. Treat engines as **library** packages
(mountable); host `Rails::Application` as **service**.

## Kind rubric

| Signal | Kind | Notes |
|--------|------|--------|
| `rails` / `railties` / sinatra / hanami / grape (+ not engine) | `service` | Full apps |
| `config/application.rb` / `Rails::Application` | `service` | Even if deps parse is weak |
| `Rails::Engine` gemspec (not Application) | `library` | Mountable package |
| gemspec `executables` | `cli` | ≈ npm `bin` |
| thor / gli / commander deps | `cli` | Weaker than executables; skip if server present |
| view_component / turbo-rails / stimulus-rails only | `surface` | Server group wins first (Rails+Hotwire stays service) |
| gemspec, no stronger signal | `library` | |
| else | `library` @ 0.4 | |

## Frameworks — include vs avoid

**Include:** rails, railties, sinatra, hanami, grape, rack; thor, gli, commander;
view_component, turbo-rails, stimulus-rails, hotwire-rails (legacy meta).

**Avoid as primary:** merb, camping, ramaze. Padrino detect-only.

**Out of scope:** Homebrew formulae (Ruby DSL, not app Gemfile/gemspec). This
harvester is for application/library repos.

## Parsing (implementation note — not in YAML)

Gemfile / gemspec are **Ruby DSLs** — do not `eval` from Node. Future harvester
should use best-effort regex / structured scan (`spec.name =`, `gem "…"`,
`add_dependency`) or a constrained parser. Skip dynamic gemspecs.

## Routes (tier-4, optional)

`routes.status: not_implemented`. Planned enrichment:

1. **Rails** — `config/routes.rb` (`get`/`post`/`resources`/`mount`)
2. Sinatra verb DSL / Grape `get`/`post` / Hanami routes

Never load-bearing ([NOMENCLATURE_INDEX_PLAN.md](../../../../../NOMENCLATURE_INDEX_PLAN.md) §4a).

## Sources

- [Bundler Gemfile](https://bundler.io/man/gemfile.5.html)
- [Rails Engines guide](https://guides.rubyonrails.org/engines.html)
- [Specification reference](https://guides.rubygems.org/specification-reference/)
- thor / gli / commander gem docs
- In-repo: `ecosystems/typescript.yaml`, `ECOSYSTEM_HARVESTERS.spec.md`
