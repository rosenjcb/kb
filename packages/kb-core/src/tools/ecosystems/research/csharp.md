# C# / .NET ecosystem harvest — research note

**Status:** coverage YAML declared (`../csharp.yaml`); inference not wired.
**Date:** 2026-07-28

## Manifests

| File | Role | Entity? |
|------|------|---------|
| `*.csproj` | Harvest atom (C#) | **Yes** — one candidate per project |
| `*.fsproj` | Harvest atom (F#) — same MSBuild / `PackageReference` shape | **Yes** — include; do not invent a separate ecosystem id |
| `*.sln` / `*.slnx` | Workspace: lists project paths + display names | No — discovery only; `part_of` → solution name optional |
| `Directory.Build.props` / `.targets` | Shared MSBuild import chain (walk parent dirs) | **Never** — merge props into project evaluation |
| `Directory.Packages.props` | Central Package Management (CPM) versions | Never — versions only; `PackageReference` still on project |
| `global.json` / `nuget.config` / `packages.config` | SDK pin / feed / legacy NuGet | Never (packages.config = pre-SDK-style; out of primary scope) |

**Identity:** `AssemblyName` → else `PackageId` → else project file stem.
**Aliases:** `RootNamespace`, solution project title, directory basename.
**Gloss:** no standard description property; README beside project/solution.

**Deps signal:** `PackageReference Include="…"` (and CPM-resolved versions). Also
`FrameworkReference Include="Microsoft.AspNetCore.App"` — common for class
libraries that use ASP.NET Core APIs without `Sdk.Web`.
`ProjectReference` = internal edges, not kind.

Parse as XML (MSBuild). Do not invoke `dotnet` / MSBuild for harvest — static
read only. Honor `Directory.Build.props` ancestors for inherited
`PackageReference` / properties when cheap; skip conditioned items that need
full evaluation if ambiguous (skip rather than guess).

Sources: [MSBuild project SDKs](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/overview),
[ASP.NET Core Web SDK](https://learn.microsoft.com/en-us/aspnet/core/razor-pages/web-sdk),
[FrameworkReference for AspNetCore.App](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/target-aspnetcore).

## Kind rubric

| Signal | Kind | Conf | Notes |
|--------|------|------|-------|
| `Sdk="Microsoft.NET.Sdk.Web"` | `service` | 0.95 | Strongest; often **no** AspNetCore PackageReference (shared framework) |
| `UsingMicrosoftNETSdkWeb` / `FrameworkReference` AspNetCore.App / `use_aspnetcore` | `service` | 0.9 | Library hosting APIs or Web SDK without parsing Sdk attr |
| `PackageReference` → server group (Grpc.AspNetCore, Orleans.Server, …) | `service` | 0.9 | Minimal APIs = ASP.NET Core, no separate NuGet |
| `Sdk="Microsoft.NET.Sdk.Worker"` | `service` | 0.85 | Background host |
| Blazor WASM / MAUI SDK or frontend PackageRefs | `surface` | 0.85–0.9 | |
| `UseWPF` / `UseWindowsForms` / `UseMaui` = true | `surface` | 0.85 | Desktop / mobile UI props |
| System.CommandLine / Spectre.Console(.Cli) | `cli` | 0.85 | |
| `OutputType=Exe`, no server SDK/deps | `cli` | 0.7 | Weak — console apps may still be services |
| `OutputType=WinExe` | `surface` | 0.7 | Desktop default |
| `OutputType=Library` | `library` | 0.8 | |
| else | `library` | 0.4 | Fallback |

**OutputType values:** `Exe` | `Library` | `WinExe` (plus rare `Module`). Default
for SDK-style classlib templates is `Library`; for console, `Exe`.

**Ordering:** Sdk.Web / AspNetCore beats `OutputType=Exe` (web apps are often
Exe). Frontend/surface before bare Exe→cli. Server PackageReference before cli
deps when both present.

## Frameworks — include vs avoid

**Include (detect):**

- **Server:** ASP.NET Core (Sdk.Web + FrameworkReference), Minimal APIs (same
  stack), Orleans (`Microsoft.Orleans.Server` / `.Sdk`), gRPC
  (`Grpc.AspNetCore`).
- **CLI:** `System.CommandLine`, `Spectre.Console` / `.Cli`.
- **Surface:** Blazor (Components.Web / WebAssembly SDK), MAUI
  (`Microsoft.NET.Sdk.Maui` / `UseMaui`), WPF (`UseWPF`), WinForms
  (`UseWindowsForms`).

**Avoid as primary:** Nancy, Katana/OWIN-only, classic `System.Web` ASP.NET
Framework, ServiceStack as default kind signal. Avalonia optional later (not
in YAML unless we see density).

## Routes (tier-4, optional)

`routes.status: not_implemented`. Planned enrichment (never load-bearing):

1. **Minimal APIs** — `MapGet` / `MapPost` / `MapPut` / `MapDelete` /
   `MapMethods` / `MapGroup` on `WebApplication` / `IEndpointRouteBuilder`.
2. **Controllers** — `[Route]` / `[HttpGet|Post|…]` / `MapControllers()`.

Missing parsers only lose endpoint granularity
([ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) §4a).

## Out of scope for this YAML

- Runtime inference / loader changes (`ecosystem-config.ts`, harvesters)
- Promoting tree-sitter `.cs` symbols to entities
- Invoking `dotnet msbuild -getProperty` / full conditioned evaluation
- VB (`*.vbproj`) — same shape if needed later; not declared yet
- NuGet lock files (`packages.lock.json`) as identity
