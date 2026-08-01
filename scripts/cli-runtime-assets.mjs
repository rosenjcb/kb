import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

/** Copy prompt + skill assets next to the bundled CLI binary. */
export async function copyCliRuntimeAssets(projectRoot, binDir) {
  const promptsSrc = path.join(projectRoot, 'packages', 'kb-core', 'src', 'prompts')
  for (const file of await readdir(promptsSrc)) {
    if (file.endsWith('.md')) {
      await copyFile(path.join(promptsSrc, file), path.join(binDir, file))
    }
  }

  const docQuestionnairesSrc = path.join(promptsSrc, 'doc-questionnaires')
  const docQuestionnairesDest = path.join(binDir, 'doc-questionnaires')
  if (existsSync(docQuestionnairesSrc)) {
    await mkdir(docQuestionnairesDest, { recursive: true })
    for (const file of await readdir(docQuestionnairesSrc)) {
      if (file.endsWith('.md')) {
        await copyFile(path.join(docQuestionnairesSrc, file), path.join(docQuestionnairesDest, file))
      }
    }
  }

  const skillsRoot = path.join(projectRoot, 'skills')
  if (existsSync(skillsRoot)) {
    for (const skillName of await readdir(skillsRoot)) {
      const skillFile = path.join(skillsRoot, skillName, 'SKILL.md')
      if (existsSync(skillFile)) {
        await copyFile(skillFile, path.join(binDir, `${skillName}.skill.md`))
      }
    }
  }

  // Ecosystem harvester YAML (one file per language/infra tier). Bundled binaries
  // resolve these next to dist/bin via ecosystem-config.ts import.meta.url.
  const ecosystemsSrc = path.join(projectRoot, 'packages', 'kb-core', 'src', 'tools', 'ecosystems')
  if (existsSync(ecosystemsSrc)) {
    const ecosystemsDest = path.join(binDir, 'ecosystems')
    await mkdir(ecosystemsDest, { recursive: true })
    for (const file of await readdir(ecosystemsSrc)) {
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        await copyFile(path.join(ecosystemsSrc, file), path.join(ecosystemsDest, file))
      }
    }
  }
}

/** Bash launcher: pinned Node major, NODE_PATH for @kb/core native deps. */
export function kbLauncherScript({ jsBasename, pinnedMajor = '24' }) {
  return `#!/usr/bin/env bash
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
# Prefer a colocated runtime node_modules (release installs), then fall back to
# the monorepo layout used during local development.
KB_NODE_PATHS=()
if [ -d "$SCRIPT_DIR/../node_modules" ]; then
  KB_NODE_PATHS+=("$(cd "$SCRIPT_DIR/../node_modules" && pwd)")
fi
if [ -d "$SCRIPT_DIR/../../../kb-core/node_modules" ]; then
  KB_NODE_PATHS+=("$(cd "$SCRIPT_DIR/../../../kb-core/node_modules" && pwd)")
fi
if [ -d "$SCRIPT_DIR/../../../../node_modules" ]; then
  KB_NODE_PATHS+=("$(cd "$SCRIPT_DIR/../../../../node_modules" && pwd)")
fi

if [ "\${#KB_NODE_PATHS[@]}" -gt 0 ]; then
  KB_JOINED_NODE_PATH="$(IFS=:; printf '%s' "\${KB_NODE_PATHS[*]}")"
  export NODE_PATH="$KB_JOINED_NODE_PATH\${NODE_PATH:+:$NODE_PATH}"
fi
KB_NODE=""
NVM_DIR="\${NVM_DIR:-\$HOME/.nvm}"
if [ -d "$NVM_DIR/versions/node" ]; then
  KB_NODE="$(ls -d "$NVM_DIR/versions/node/v${pinnedMajor}."*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$KB_NODE" ]; then
  KB_NODE="$(command -v node)"
fi
exec "$KB_NODE" --no-warnings "$SCRIPT_DIR/${jsBasename}" "$@"
`
}
