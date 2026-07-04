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
# tree-sitter WASM + other @kb/core runtime deps live under the core package.
KB_CORE_NODE_MODULES="$(cd "$SCRIPT_DIR/../../../kb-core/node_modules" && pwd)"
KB_ROOT_NODE_MODULES="$(cd "$SCRIPT_DIR/../../../../node_modules" && pwd)"
export NODE_PATH="$KB_CORE_NODE_MODULES:$KB_ROOT_NODE_MODULES\${NODE_PATH:+:$NODE_PATH}"
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
