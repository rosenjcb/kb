# PHP / Composer ecosystem harvest — research note

**Status:** coverage YAML declared (`php.yaml`); inference not wired.

## Manifests

- **`composer.json`** — harvest atom. `name` (`vendor/package`) is canonical
  identity. `description` → gloss; else README. Aliases: package segment after
  `/`, plus containing-dir basename when useful.
- **`composer.lock`** — lock companion only (exact resolved `require` graph).
  **Never** an entity. May later corroborate framework presence when
  `composer.json` uses wildcards / path aliases, but identity always comes from
  `composer.json`.
- **Path repositories** — Composer has **no** pnpm/Cargo-style workspace table.
  Monorepos declare local members via
  `repositories: [{ "type": "path", "url": "packages/foo" }]` (optional
  `options.symlink`). Harvest: walk `type: path` URLs → member `composer.json`
  roots; also discover nested `composer.json` trees as fallback. Ignore
  `vcs` / `composer` / `artifact` / `package` repo types for workspace
  enumeration (those are remotes or inline defs, not member packages).

## Kind rubric

| Signal | Kind | Notes |
|--------|------|--------|
| `laravel/framework`, `lumen-framework`, `slim/slim`, `mezzio/mezzio`, `codeigniter4/framework`, Symfony HTTP stack | `service` | Exact Packagist names in `require` / `require-dev` |
| `type: project` (no bin) | `service` | App skeleton; weaker than framework deps |
| `bin` array | `cli` | Composer-exposed executables |
| root `artisan` file | `cli` | Laravel Artisan — usually **not** listed in `bin` |
| `symfony/console` without server group | `cli` | Console alone; Laravel/Symfony apps already matched as `service` |
| `livewire/livewire`, `inertiajs/inertia-laravel` | `surface` | UI layer; often co-deps with Laravel → `service` wins first |
| `type: library` | `library` | Default Composer type when omitted is also library |
| else | `library` | Weak fallback |

`type: metapackage` / `composer-plugin` — do not elevate; skip or leave at
fallback library unless a later pass needs them.

## Frameworks — include vs avoid

**Include (detect):**

- **Server:** `laravel/framework`, `laravel/lumen-framework`, `slim/slim`,
  `mezzio/mezzio`, `codeigniter4/framework`, `symfony/framework-bundle`,
  `symfony/http-kernel`, `symfony/http-foundation` (weak).
- **CLI:** `symfony/console` + Laravel `artisan` file signal.
- **Surface:** `livewire/livewire`, `inertiajs/inertia-laravel` — useful when a
  package is UI-primary; apps with Laravel still classify as `service`.

**Symfony `*`:** YAML lists concrete packages for exact match. Optional loader
enhancement: treat any `require` key with vendor prefix `symfony/` + HTTP/console
components as group hits — do not invent a literal `symfony/*` dependency name.

**Avoid as primary:** CakePHP 2 / Zend Framework 1 era trees, Yii1, FuelPHP,
Phalcon (extension-coupled), Silex (EOL). Detect only if corpus density later
justifies.

## Routes (tier-4, optional)

`routes.status: not_implemented`. Planned enrichment order:

1. **Laravel** — `routes/web.php`, `routes/api.php`, other `routes/*.php`
   (`Route::get/post/…`, `apiResource`)
2. **Symfony** — `config/routes*.yaml` + PHP 8 `#[Route]` attributes
3. **Slim** — `$app->get/post(…)` map in bootstrap

Never load-bearing; missing parsers only lose endpoint granularity
([ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) §4a).

## Out of scope for this YAML

- Runtime inference / loader changes (`ecosystem-config.ts`, harvesters)
- Promoting tree-sitter PHP symbols to entities
- Treating `composer.lock` as identity
- Packagist / network resolution of path or VCS repos

## Sources

- [composer.json schema](https://getcomposer.org/doc/04-schema.md) (`name`,
  `type`, `bin`, `require`, `repositories`)
- [Path repositories](https://getcomposer.org/doc/05-repositories.md#path)
- Packagist: laravel/framework, slim/slim, mezzio/mezzio,
  laravel/lumen-framework, codeigniter4/framework, livewire/livewire,
  inertiajs/inertia-laravel, symfony/console
- [ECOSYSTEM_HARVESTERS.spec.md](../../ECOSYSTEM_HARVESTERS.spec.md) (tier-2 manifests; tier-4 routes optional)
