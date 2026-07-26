// Payload run *inside* the container by local-embedder-load-bench.sh — see that
// script for why this needs a real Linux node_modules install rather than
// running against the repo's own (host-platform) node_modules.
function rssMiB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
}

console.log(`[baseline] rss=${rssMiB()}MiB`)
const { pipeline } = await import('@huggingface/transformers')
console.log(`[after import] rss=${rssMiB()}MiB`)

const t0 = Date.now()
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
console.log(`[after model load] rss=${rssMiB()}MiB elapsed=${Date.now() - t0}ms`)

const output = await extractor(['hello world', 'a second sentence to embed'], {
  pooling: 'mean',
  normalize: true,
})
const vectors = output.tolist()
console.log(`[after first embed call] rss=${rssMiB()}MiB dims=${vectors[0].length}`)

if (global.gc) {
  global.gc()
  console.log(`[after gc] rss=${rssMiB()}MiB`)
}
