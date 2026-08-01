# C / C++ ecosystem harvest — research note

**Status:** coverage YAML declared (`cpp.yaml`); inference not wired.
**Date:** 2026-07-28

C and C++ share one ecosystem id (`cpp`, display **C / C++**). There is no
npm/`package.json`-grade universal package identity. Harvest must tolerate
missing names, multiple build systems, and system-installed deps that never
appear in-repo.

## Why identity is weak

| Ecosystem | Strong atom | C/C++ analogue |
|-----------|-------------|----------------|
| npm | `package.json` `name` | — |
| Cargo | `[package].name` | — |
| Go | `go.mod` `module` | — |
| C/C++ | **none universal** | CMake `project()`, vcpkg `name`, Conan recipe name, meson `project()`, xmake `set_project` — optional and inconsistent |

Many real repos (raylib, stb-style header libs, embedded SDKs) are **libraries**
with a Makefile/CMakeLists and no package-manager manifest. Kind fallback
`library @ 0.4` is the expected common case, not a classification failure.

## Manifests (strongest → weakest)

### Package managers (prefer when present)

- **`vcpkg.json`** — closest to a package atom. `name` (and optional
  `dependencies[]`) are harvestable. Manifest mode is common in apps consuming
  ports; ports themselves may live out of tree.
- **`conanfile.py` / `conanfile.txt`** — recipe identity. `.py` can declare
  `name`/`version`; `.txt` is often `[requires]` only (consumer, weak/no name).
- **`xmake.lua`** — `set_project("name")` / `target("name")`. Less common than
  CMake but has an explicit project name.

### Build systems (common; name optional)

- **`CMakeLists.txt`** — `project(Name …)` is the primary in-repo name when no
  vcpkg/conan/xmake name exists. Nested `add_subdirectory` trees may yield
  multiple `project()` calls — treat each as a candidate only when it looks like
  a real package root (has its own targets / install rules), not every leaf.
- **`meson.build`** — `project('name', …)` at the root. Similar strength to
  CMake `project()`.

### Weak / non-identity

- **`Makefile` / `makefile`** — ubiquitous, especially in C libraries. Targets
  (`all`, `install`, `$(NAME).a`) are **not** stable package identity. Role:
  `weak_package`. Use only when nothing stronger exists; confidence must stay
  low; prefer directory basename over a guessed `TARGET`.
- **`compile_commands.json`** — clangd / IDE compilation database. Lists
  translation units and flags. **Never an entity.** Role: `companion`. May
  later help *locate* sources, not name packages.
- **pkg-config `*.pc`** — strong *when present in-repo* (`Name:`, `Description:`),
  but rare: most `.pc` files are generated at install time under
  `/usr/lib/pkgconfig`. Do not scan the system; only harvest committed
  `*.pc` under the repo.

## Kind rubric — inherently low confidence

Dep signals are noisier than npm:

- Header-only / `#include` without a declared dep
- System packages (`libgtk`, `qt6-base`) absent from vcpkg/conan files
- Boost as a monolith (`boost` Conan package) vs component names
- CMake `find_package` names ≠ vcpkg port names ≠ include paths

Cap confidence below TS/Go/Rust equivalents even when a framework token matches.

| Signal | Kind | Confidence | Notes |
|--------|------|------------|--------|
| crow / oatpp / pistache / drogon / cpprestsdk / grpc / boost.beast | `service` | ≤0.7 | Best available server signal |
| qt / gtk / imgui / wxwidgets | `surface` | ≤0.65 | GUI / immediate-mode UI |
| cli11 / cxxopts / boost.program_options | `cli` | ≤0.65 | |
| public headers / install(FILES) rules, no server deps | `library` | ~0.45 | |
| else (typical) | `library` | 0.4 | raylib-style default |

Do **not** invent high-confidence kinds from `add_executable` alone — almost every
CMake tutorial builds an exe for a library demo.

## Frameworks — include vs avoid

**Server (detect):** Crow, Oat++, Pistache, Drogon, cpprestsdk (Casablanca),
gRPC (`grpc` / `grpc++`), Boost.Beast.

**CLI (detect):** CLI11, cxxopts, Boost.Program_options.

**Surface (detect):** Qt (Qt5/Qt6 / `qtbase`), GTK / gtkmm, Dear ImGui, wxWidgets.

**Name normalization (harvester impl):** collapse case and separators so
`boost.beast`, `boost-beast`, `Boost::beast`, `<boost/beast.hpp>` share a token.
Same for `boost.program_options` / `boost-program-options` / `Boost::program_options`.

**Avoid as primary:** Boost.Asio alone, raw sockets, libcurl alone — too common
as utilities without implying a service entity.

## Routes

`routes.status: **not_applicable**`.

Unlike Nest/Express/axum, there is no manifesto-class route table in C/C++.
Handler registration is in-code (e.g. Crow `CROW_ROUTE`, Drogon macros). That
belongs to optional AST enrichment later — and even then it is symbol-tier, not
manifest harvest. Prefer `not_applicable` over `not_implemented` so planners do
not expect a future YAML-driven route parser for this ecosystem.

## Symbols

`symbols.status: not_implemented` — tree-sitter `cpp` grammar already indexes
`.c`/`.h`/`.cpp`/`.cc`/`.hpp` in the code-index cycle. Do not promote those
symbols to entity candidates from this harvester.

## Out of scope for this YAML

- Wiring `ecosystem-config.ts` / `ecosystem-harvesters.ts`
- Scanning system `/usr` pkg-config or Homebrew prefixes
- Treating `compile_commands.json` or object files as entities
- Distinguishing C-only vs C++-only as separate ecosystem ids
- Autotools `configure.ac` / `Makefile.am` (document later if needed; weaker
  than CMake/meson for modern repos)

## Sources

- CMake `project()` — [cmake-commands(7)](https://cmake.org/cmake/help/latest/command/project.html)
- Meson `project()` — [Meson reference](https://mesonbuild.com/Reference-manual_functions.html#project)
- vcpkg manifest mode — [vcpkg.json](https://learn.microsoft.com/en-us/vcpkg/reference/vcpkg-json)
- Conan recipes — [conanfile.py](https://docs.conan.io/2/reference/conanfile.html)
- xmake — [set_project / target](https://xmake.io/#/manual/project_target)
- Compilation database — [JSON Compilation Database](https://clang.llvm.org/docs/JSONCompilationDatabase.html)
- [ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) (tier-2 manifests; tier-4 routes optional)
- Eval fixture: raylib (`eval/suites/raylib.yaml`) — Makefile-primary C library
