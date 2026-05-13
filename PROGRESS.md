# kb sync fix — progress notes

## Goal
Make `kb sync` work end-to-end for users without requiring `pnpm approve-builds`.

---

## Key findings

### Two separate installations exist on this machine
| Path | Status |
|------|--------|
| `~/Library/pnpm/global/5/` | **Working** — `better_sqlite3.node` compiled |
| `~/.kb/pnpm-global/5/` | **Broken** — no `.node` file |

`which kb` → `/Users/rosenjcb/Library/pnpm/kb` (pnpm global, currently working)

---

### The published binary vs current source code are DIVERGED

**Published binary** (`~/Library/pnpm/global/5/node_modules/kb/dist/bin/kb.js`):
- Installs to a custom `KB_HOME = ~/.kb`, with `PNPM_GLOBAL_DIR = ~/.kb/pnpm-global`
- Runs `pnpm add -g --global-dir ~/.kb/pnpm-global <tgz>` with `PNPM_HOME=~/.kb/bin`
- Then runs `pnpm rebuild better-sqlite3 --dir <importerDir>` with `PNPM_HOME=~/.kb/bin`
- Shows "Install location: /Users/rosenjcb/.kb/bin" in output

**Current source** (`src/cli/sync-cli.ts` on main):
- Uses `pnpm root -g` to find user's system pnpm global
- Installs via `pnpm add -g <tgz>` (no custom dir)
- Rebuilds via `pnpm rebuild better-sqlite3 --dir <importerDir>`
- Shows "Install location: ~/Library/pnpm" in output

---

### Root cause: `pnpm rebuild` is silently a no-op

Running `pnpm rebuild better-sqlite3 --dir ~/.kb/pnpm-global/5` exits 0 but produces no output and does NOT compile the native module. Even with `--config.allow-build=better-sqlite3` added — same result.

**Confirmed fix**: Running `npm rebuild` inside the `better-sqlite3` package directory works:
```bash
cd ~/.kb/pnpm-global/5/.pnpm/better-sqlite3@12.9.0/node_modules/better-sqlite3
npm rebuild
# → "rebuilt dependencies successfully"
# → creates build/Release/better_sqlite3.node ✓
```

---

### `pnpm add --allow-build` IS available in pnpm 10.33.2

```
pnpm add --help | grep allow-build
→ --allow-build   A list of package names that are allowed
```

`pnpm rebuild` does NOT support `--allow-build`.

**Untested**: whether `pnpm add -g --allow-build=better-sqlite3 <tgz>` compiles the native module during install (avoiding a separate rebuild step). This is worth trying first.

---

## Proposed fix for `src/cli/sync-cli.ts`

Two options (in order of preference):

### Option A — `pnpm add --allow-build` during install (cleaner)
Change the install command to:
```
pnpm add -g --allow-build=better-sqlite3 <tgz>
```
This compiles `better-sqlite3` at install time, no separate rebuild step needed.
**Needs testing** — not yet confirmed to work end-to-end.

### Option B — `npm rebuild` in the better-sqlite3 dir (confirmed works)
After `pnpm add -g <tgz>`:
1. Find the `better-sqlite3` dir inside the pnpm global store (e.g. glob `<globalRoot>/.pnpm/better-sqlite3*/node_modules/better-sqlite3`)
2. Run `npm rebuild` in that directory

This is confirmed to produce `build/Release/better_sqlite3.node`.

---

## Test to update

`tests/cli/sync-cli.test.ts` line 33-36 hardcodes the exact pnpm commands:
```typescript
if (joined === `pnpm add -g ${RELEASE_TARBALL_URL}`) { ... }
if (joined === `pnpm rebuild better-sqlite3 --dir ${PNPM_IMPORTER_DIR}`) { ... }
```
These need updating to match whatever new command sequence we land on.

---

## What was NOT done yet
- Test Option A (`--allow-build`) end-to-end with a real pnpm global install
- Update `sync-cli.ts` source with the fix
- Update the test to match new command sequence
- Build & publish a new release to verify `kb sync` works from scratch
