# Research Paper

**KB: A Facts-First Codebase Knowledge System with Multi-Objective Exploration Loss Evaluation**

The paper lives in this directory as a standard LaTeX two-column article.

## Prerequisites

You need a TeX Live installation with `latexmk`. On macOS:

```bash
# Full install (~4 GB, never worry about missing packages)
brew install --cask mactex

# Minimal install (~100 MB) — then add the few packages we use
brew install --cask basictex
# Open a NEW terminal after install, then:
sudo tlmgr update --self
sudo tlmgr install latexmk booktabs microtype caption
```

Verify the install worked:

```bash
latexmk --version   # should print Version 4.x
```

## Build

From the repo root:

```bash
pnpm run research:build   # compiles → research/main.pdf
pnpm run research:clean   # removes all latexmk-generated files
```

Or directly from this directory:

```bash
make pdf     # compile
make watch   # auto-recompile on save (opens with system PDF viewer)
make clean   # remove build artifacts
```

VS Code users with the **LaTeX Workshop** extension (`James-Yu.latex-workshop`) get
auto-compile on save out of the box — just open `main.tex`.

## Structure

```
research/
  main.tex              Root document (twocolumn article class)
  refs.bib              BibTeX references (~20 entries)
  Makefile              latexmk targets: pdf / watch / clean
  sections/
    intro.tex           Introduction and contributions
    related.tex         Related work
    method.tex          KB system + MOEL framework (all math)
    eval.tex            Experiments and results tables
    conclusion.tex      Limitations and future work
  tables/
    benchmark-alignment.tex   MOEL vs SWE Atlas / ContextBench / CodeScaleBench
  figures/              Drop rendered figures here (PDF or PNG)
  generated/            Scratch space for auto-generated assets
```

## Figures

Three figures are currently placeholder boxes in the PDF. To replace them,
drop a PDF or PNG into `figures/` and swap the `\fbox{\parbox{...}}` block
in the relevant section with:

```latex
\includegraphics[width=\columnwidth]{figures/your-figure.pdf}
```

| Label | Description |
|-------|-------------|
| `fig:system-overview` | End-to-end KB + MOEL flow (intro.tex) |
| `fig:kb-arch` | KB indexing and multi-pond BFS retrieval (method.tex) |

## Output

The compiled PDF is **`research/main.pdf`** — commit it after rebuilding when the paper changes. LaTeX intermediates (`*.aux`, `*.out`, `*.log`, etc.) are gitignored via `research/.gitignore`.
