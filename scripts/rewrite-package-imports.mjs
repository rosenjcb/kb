/**
 * Rewrite monolith relative imports to workspace package imports after src/ split.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(abs, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(abs)
  }
  return acc
}

function rewriteImportPath(imp, prefix, pkg) {
  if (prefix === 'version') {
    return '@kb/core/version.js'
  }
  const normalized = imp.replace(/^\.\.\//, '')
  const withJs = normalized.endsWith('.js') ? normalized : `${normalized}.js`
  return `@kb/${pkg}/${withJs}`
}

function rewriteContent(content, packageName) {
  let out = content

  const applyPrefix = (prefix, pkg) => {
    const segment =
      prefix === 'version'
        ? 'version(?:\\.js)?'
        : `${prefix}/[^'"]+`
    const re = new RegExp(`from (['"])(\\.\\./${segment})\\1`, 'g')
    out = out.replace(re, (_m, q, imp) => {
      return `from ${q}${rewriteImportPath(imp, prefix, pkg)}${q}`
    })
    const reDyn = new RegExp(`import\\((['"])(\\.\\./${segment})\\1\\)`, 'g')
    out = out.replace(reDyn, (_m, q, imp) => {
      return `import(${q}${rewriteImportPath(imp, prefix, pkg)}${q})`
    })
  }

  if (packageName === 'kb-client') {
    for (const p of ['core', 'tools', 'intents', 'prompts', 'skills']) applyPrefix(p, 'core')
    applyPrefix('version', 'core')
    applyPrefix('server', 'server')
  } else if (packageName === 'kb-server') {
    for (const p of ['core', 'tools', 'intents', 'prompts', 'skills']) applyPrefix(p, 'core')
    applyPrefix('cli', 'client')
  } else if (packageName === 'kb-core') {
    applyPrefix('cli', 'client')
  }

  // tests: ../../src/X -> @kb/...
  out = out.replace(
    /from (['"])\.\.\/\.\.\/src\/(core|tools|intents|prompts|skills|cli|tui|ui|server)\/([^'"]+)\1/g,
    (_m, q, area, rest) => {
      const pkg =
        area === 'core' || area === 'tools' || area === 'intents' || area === 'prompts' || area === 'skills'
          ? 'core'
          : area === 'server'
            ? 'server'
            : 'client'
      const withJs = rest.endsWith('.js') ? rest : `${rest}.js`
      return `from ${q}@kb/${pkg}/${area}/${withJs}${q}`
    },
  )
  out = out.replace(/from (['"])\.\.\/\.\.\/src\/version(?:\.js)?\1/g, (_m, q) => {
    return `from ${q}@kb/core/version.js${q}`
  })

  return out
}

function processDir(relDir, packageName) {
  const absDir = path.join(root, relDir)
  if (!statSync(absDir).isDirectory()) return
  for (const abs of walk(absDir)) {
    const before = readFileSync(abs, 'utf-8')
    const after = rewriteContent(before, packageName)
    if (after !== before) writeFileSync(abs, after)
  }
}

processDir('packages/kb-client/src', 'kb-client')
processDir('packages/kb-server/src', 'kb-server')
processDir('packages/kb-core/src', 'kb-core')
processDir('tests', 'tests')

console.log('Import rewrite complete')
