# Java / Kotlin (JVM) ecosystem research

**Status:** coverage YAML declared (`java.yaml`); inference not wired.
**Date:** 2026-07-28

Kotlin does **not** get a separate ecosystem id — it shares Maven/Gradle
manifests with Java. Harvest under `id: java`.

## Manifests

| Signal | Role | Entity atom |
|--------|------|-------------|
| `pom.xml` | Package (Maven) | One module per POM; identity `<artifactId>` (alias `groupId:artifactId`) |
| `build.gradle` / `build.gradle.kts` | Package (Gradle) | One project per build script |
| `settings.gradle` / `settings.gradle.kts` | Workspace | `include` / `includeFlat` → member project dirs |
| `gradle/libs.versions.toml` | Catalog only | Version/library aliases for dep matching — **never** an entity |

### Maven

- Reactor multi-module: root `<modules>` lists child dirs; root often
  `<packaging>pom</packaging>` (aggregator) — emit members; optional weak root.
- Gloss from `<description>` / `<name>`; else README.
- Skip `target/`.

### Gradle

- Multi-project: `settings.gradle(.kts)` `include("app")` / `include(":lib")`.
  Each included dir has its own `build.gradle(.kts)`.
- Identity: `rootProject.name`, project path (`:app`), else directory basename.
  Prefer `base.archivesName` / legacy `archivesBaseName` when set.
- **Version catalogs** (`gradle/libs.versions.toml`): resolve `libs.foo` aliases
  when matching `frameworks.*`; do not emit a catalog entity.
- Skip `build/`, `.gradle/`.

Sources: [Maven POM](https://maven.apache.org/pom.html),
[Gradle multi-project](https://docs.gradle.org/current/userguide/multi_project_builds.html),
[Version catalogs](https://docs.gradle.org/current/userguide/platforms.html).

## Kind rubric — packaging plugins / mainClass

| Signal | Kind | Notes |
|--------|------|--------|
| `org.springframework.boot` plugin / spring-boot starters | `service` | Strongest (~0.95 plugin, ~0.9 deps) |
| Quarkus / Micronaut / Dropwizard / Helidon / Vert.x / Ktor | `service` | Server group |
| `<packaging>war</packaging>` / war plugin | `service` | Deployable web archive |
| Vaadin / OpenJFX (no AGP) | `surface` | Desktop/web UI |
| `com.android.application` (AGP) | `surface` | **Careful** — mobile app; see below |
| picocli / JCommander + `mainClass` | `cli` | |
| `application` plugin + `mainClass`, no server deps | `cli` | Gradle Application plugin |
| jar / java-library, no main | `library` | |
| bare `mainClass`, no stronger signal | `library` | Weak (~0.55) — demos/tools |
| else | `library` | Fallback 0.4 |

Maven `maven-jar-plugin` / `maven-shade-plugin` `mainClass`, Gradle
`application { mainClass.set(...) }` / `jar { manifest { attributes("Main-Class") } }`
are the primary executable signals when framework deps are absent.

## Frameworks — include vs avoid

**Server:** Spring Boot (plugin + `spring-boot-starter-web` / webflux), Quarkus,
Micronaut, Dropwizard, Helidon, Vert.x, **Ktor** (Kotlin-first HTTP).

**CLI:** picocli (dominant), JCommander (still common).

**Surface:** Vaadin (server-side web UI), JavaFX / OpenJFX (desktop).

**Android (careful):** AGP (`com.android.application` / `library`) marks a
**mobile** surface, not Vaadin/JavaFX. List in YAML for detect-only; do not
treat every `com.android.library` AAR as a product surface — prefer
`application` + `applicationId`. Android is a distinct toolchain (SDK, APK);
overlap with plain JVM libs is real (shared Kotlin/Java sources) but kind
signals differ. Dual-claim with a future dedicated Android ecosystem is OK;
until then, weak surface only when AGP application plugin present.

**Avoid as primary:** SparkJava / Javalin as frontier defaults (still exist;
add later if surveys warrant). Struts 1.x / ancient servlet-only stacks —
legacy detect only if needed.

## Routes (tier-4, optional)

`routes.status: not_implemented`. Planned enrichment order:

1. **Spring MVC** — `@RequestMapping` / `@GetMapping` / `@PostMapping` (and
   class-level path prefix composition)
2. **Spring WebFlux** — `RouterFunction` / annotated controllers
3. Quarkus / Micronaut (JAX-RS-style / own annotations)
4. Ktor routing DSL (`routing { get(...) }`)

Never load-bearing; missing parsers only lose endpoint granularity
([NOMENCLATURE_INDEX_PLAN.md](../../../../../NOMENCLATURE_INDEX_PLAN.md) §4a).

## Overlap

- **Scala** (`scala.yaml`): Maven/Gradle with Scala plugin + `src/main/scala`
  → prefer Scala YAML; dual candidates OK until registry merge.
- **Kotlin symbols:** tree-sitter Kotlin has no WASM build — `.kt` not
  AST-indexed ([INIT.md](../../core/INIT.md)); harvester still uses Gradle/Maven
  manifests for entities.

## Out of scope for this YAML

- Wiring `ecosystem-config.ts` / `ecosystem-harvesters.ts`
- Promoting tree-sitter `.java` symbols to entities
- Lockfiles / caches as identity (`pom.xml` checksums, Gradle lockfiles)
- Bazel / Ant as first-class JVM workspace sources (revisit if needed)
- Android resource/manifest harvest beyond AGP plugin detect
