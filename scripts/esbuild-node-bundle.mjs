/**
 * Shared esbuild options for kb / kb-server binaries.
 *
 * Bundle pure JS dependencies so global symlinks and Docker CMD work without
 * relying on pnpm hoisting or a developer's ~/node_modules. Keep native /
 * WASM grammar packages external — they load via createRequire at runtime.
 */

/** Top-level `require` so esbuild's __require shim resolves Node built-ins in bundled CJS (signal-exit, etc.). */
const REQUIRE_BANNER = [
  `import { createRequire as __kbCreateRequire } from 'node:module';`,
  'var require = __kbCreateRequire(import.meta.url);',
].join('\n')

const NATIVE_EXTERNAL_EXACT = new Set([
  '@ast-grep/napi',
  '@coderabbitai/ast-grep-langs',
  '@huggingface/transformers',
  'web-tree-sitter',
])

function isNativeExternal(id) {
  if (NATIVE_EXTERNAL_EXACT.has(id)) return true
  return id.startsWith('tree-sitter-')
}

/**
 * `ink` statically imports `react-devtools-core` from its `devtools.js`, which it only
 * loads under `DEV=true`. esbuild still pulls that module into the graph and hoists the
 * static import to the top of the bundle, so leaving it `external` makes Node eagerly
 * resolve a package we never install and crash on *every* command. Stub it with an inert
 * module instead — the devtools path never runs in production, so this is a no-op there.
 */
const STUB_MODULES = new Set(['react-devtools-core'])

/** @returns {import('esbuild').Plugin} */
export function nativeExternalsPlugin() {
  const stubNamespace = 'kb-stub'
  return {
    name: 'kb-native-externals',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith('node:')) return undefined
        if (STUB_MODULES.has(args.path)) return { path: args.path, namespace: stubNamespace }
        if (isNativeExternal(args.path)) return { path: args.path, external: true }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: stubNamespace }, () => ({
        contents: 'export default { connectToDevTools() {} }',
        loader: 'js',
      }))
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
    banner: { js: REQUIRE_BANNER },
    plugins: [nativeExternalsPlugin(), ...extraPlugins],
    ...rest,
  }
}
