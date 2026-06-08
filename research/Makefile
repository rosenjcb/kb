# Research paper build — uses latexmk (handles reruns automatically)
#
# macOS install (one-time):
#   brew install --cask basictex
#   (open a NEW terminal, then:)
#   sudo tlmgr update --self
#   sudo tlmgr install latexmk booktabs microtype caption

MAIN = main

.PHONY: all pdf clean watch

all: pdf

pdf:
	latexmk -pdf -interaction=nonstopmode $(MAIN).tex
	@echo "→ $(MAIN).pdf"

watch:
	latexmk -pdf -pvc $(MAIN).tex

clean:
	latexmk -C
