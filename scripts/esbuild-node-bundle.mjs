/**
 * Shared esbuild options for kb / kb-server binaries.
 *
 * Bundle pure JS dependencies so global symlinks and Docker CMD work without
 * relying on pnpm hoisting or a developer's ~/node_modules. Keep native /
 * WASM grammar packages external — they load via createRequire at runtime.
 */

const NATIVE_EXTERNAL_EXACT = new Set([
  '@ast-grep/napi',
  '@coderabbitai/ast-grep-langs',
  '@huggingface/transformers',
  'web-tree-sitter',
  // Optional ink devtools hook — not installed in production builds.
  'react-devtools-core',
])

function isNativeExternal(id) {
  if (NATIVE_EXTERNAL_EXACT.has(id)) return true
  return id.startsWith('tree-sitter-')
}

/** @returns {import('esbuild').Plugin} */
export function nativeExternalsPlugin() {
  return {
    name: 'kb-native-externals',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith('node:')) return undefined
        if (isNativeExternal(args.path)) return { path: args.path, external: true }
        return undefined
      })
    },
  }
}

/** @param {import('esbuild').BuildOptions} [extra] */
export function nodeBundleOptions(extra = {}) {
  const { plugins: extraPlugins = [], ...rest } = extra
  return {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    packages: 'bundle',
    plugins: [nativeExternalsPlugin(), ...extraPlugins],
    ...rest,
  }
}
