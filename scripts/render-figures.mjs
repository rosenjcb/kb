#!/usr/bin/env node
/**
 * Render every research/figures/*.mmd Mermaid source into a PDF of the same name,
 * so `pnpm run research:build` embeds current diagrams via \includegraphics —
 * never hand-drawn, never committed as a rasterized placeholder.
 *
 *   pnpm run research:figures
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const figuresDir = path.join(root, 'research', 'figures')

const CHROME_CANDIDATES = [
  process.env.MERMAID_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

function resolveChromePath() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p))
}

function writePuppeteerConfig(chromePath) {
  const configPath = path.join(os.tmpdir(), 'kb-mermaid-puppeteer-config.json')
  fs.writeFileSync(configPath, JSON.stringify({ executablePath: chromePath }))
  return configPath
}

const mmdFiles = fs.readdirSync(figuresDir).filter((f) => f.endsWith('.mmd'))
if (mmdFiles.length === 0) {
  console.log('[figures] no .mmd sources found under research/figures/')
  process.exit(0)
}

const chromePath = resolveChromePath()
const puppeteerConfigPath = chromePath ? writePuppeteerConfig(chromePath) : null
if (!chromePath) {
  console.warn(
    '[figures] no local Chrome/Chromium found; relying on mermaid-cli/puppeteer default resolution ' +
      '(set MERMAID_CHROME_PATH to override)'
  )
}

function resolveGhostscript() {
  for (const candidate of ['gs', '/usr/local/bin/gs', '/opt/homebrew/bin/gs']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {}
  }
  return null
}

const gsPath = resolveGhostscript()
if (!gsPath) {
  console.warn(
    '[figures] ghostscript (gs) not found — figures will keep Chrome-print-to-PDF\'s ' +
      'compressed-xref structure, which pdflatex\\includegraphics can corrupt into a broken ' +
      'main.pdf. Install ghostscript (e.g. `brew install ghostscript`) to normalize output.'
  )
}

for (const file of mmdFiles) {
  const inPath = path.join(figuresDir, file)
  const outPath = path.join(figuresDir, file.replace(/\.mmd$/, '.pdf'))
  const args = ['--yes', '@mermaid-js/mermaid-cli', '-i', inPath, '-o', outPath, '-b', 'white', '-f']
  if (puppeteerConfigPath) args.push('-p', puppeteerConfigPath)
  console.log(`[figures] rendering ${file} → ${path.basename(outPath)}`)
  execFileSync('npx', args, { stdio: 'inherit', cwd: root })

  if (gsPath) {
    // mermaid-cli's PDF (Chrome print-to-pdf) uses compressed cross-reference streams that
    // pdflatex's \includegraphics embedding can misparse, corrupting main.pdf's own object
    // offsets. Ghostscript rewrites it to a classic-xref PDF 1.4 file pdflatex handles cleanly.
    const normalizedPath = `${outPath}.normalized`
    execFileSync(
      gsPath,
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        `-sOutputFile=${normalizedPath}`,
        outPath,
      ],
      { stdio: 'inherit' }
    )
    fs.renameSync(normalizedPath, outPath)
  }
}

console.log(`[figures] rendered ${mmdFiles.length} diagram(s) → research/figures/*.pdf`)
