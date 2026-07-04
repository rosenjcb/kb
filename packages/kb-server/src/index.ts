#!/usr/bin/env node
/**
 * kb-server daemon entry point.
 */
import { runServerMain } from './server-cli.js'

runServerMain(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
