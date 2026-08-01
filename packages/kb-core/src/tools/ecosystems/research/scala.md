# Scala ecosystem research

Status: `planned` — coverage YAML declared; no Scala harvester in
`ecosystem-harvesters.ts` yet. Runtime must not load this note.

## Manifests / identity

| Signal | Role | Entity atom |
|---|---|---|
| `build.sbt` + `project/` | Primary (sbt) | Each `lazy val … = (project in file(…))`; identity from `name` / `organization` |
| `project/build.properties`, `plugins.sbt`, `*.scala` | Meta-build | Not entities; source of plugins + shared `libraryDependencies` |
| `build.sc` / `build.mill` (+ `package.mill`) | Primary (Mill) | Each `object` extending `ScalaModule` / `ScalaJSModule`; nested objects → `part_of` |
| Bazel `WORKSPACE` / `BUILD` + `rules_scala` | Rare | Only when Scala targets dominate; otherwise ignore |
| `pom.xml` / Gradle with Scala plugin | Secondary | Same module shape as `java.yaml`; claim when `src/main/scala` or scala plugin present |

sbt multi-project: root often `publish / skip := true` aggregator — emit member
projects, optionally a weak root. Mill maps filesystem folders to module names.
Skip `target/`, `project/target/`, `out/` (Mill), `.bloop/`, `.metals/`.

## Frameworks

**Server (strong → service):** Play (`EnablePlugins(PlayScala)` + `conf/routes`),
http4s, zio-http, Tapir (endpoint layer, usually on http4s/ZIO), akka-http
(still common; BSL), **pekko-http** (OSS fork — list for new OSS repos).

**Finatra:** listed but **legacy/niche**. Last OSS tag `22.12.0` (Dec 2022);
README still claims X/Twitter production use. Do not treat as greenfield default.

**CLI:** decline, scopt, case-app — pair with `Compile / mainClass` / Mill
`def mainClass` when present.

**Surface:** Scala.js plugin / `ScalaJSModule` + **Laminar** (`com.raquo:::laminar`)
as the primary UI signal. Slinky / scalajs-react / Tyrian exist; omit from
primary list to avoid noise.

## Kind rubric

1. Server deps or Play plugin → `service` (~0.9)
2. Scala.js plugin / Laminar → `surface` (~0.75–0.85)
3. CLI lib (+ mainClass) → `cli`
4. Publishable / no main → `library`
5. Empty fallback → `library` @ 0.4

Runnable `mainClass` without server/cli deps is weak (~0.55 service) — demos and
scripts pollute if over-trusted.

## Routes

`routes.status: not_implemented`. Planned enrichment only:

- **Play** — parse `conf/routes` (method + path + controller action)
- **http4s** — `HttpRoutes` / path DSL (AST; lower confidence)

Tapir endpoints are OpenAPI-adjacent; defer until interface-contract tier (plan
§4a tier 3) is clearer. Never promote routes to top-level deployable entities.

## Overlap

Maven/Gradle Scala modules overlap `java.yaml`. Prefer this file when Scala
plugin + `.scala` sources dominate; dual candidates OK until registry merge.

## Sources

- [sbt multi-project](https://www.scala-sbt.org/1.x/docs/Multi-Project.html)
- [Mill Scala modules](https://mill-build.org/mill/scalalib/intro.html)
- [Pekko HTTP](https://pekko.apache.org/docs/pekko-http/current/)
- [Laminar](https://laminar.dev/) / [raquo/Laminar](https://github.com/raquo/laminar)
- [twitter/finatra releases](https://github.com/twitter/finatra/releases) (stale OSS cadence)
- In-repo: `ecosystems/typescript.yaml`, `ECOSYSTEM_HARVESTERS.spec.md`, `ECOSYSTEM_HARVESTERS.spec.md`
