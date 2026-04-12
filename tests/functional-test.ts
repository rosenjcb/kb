/**
 * Functional Test: Agent Loop with Real Tool Execution
 * This demonstrates the full end-to-end flow:
 * 1. User query → sent to LLM
 * 2. LLM responds (may call tools)
 * 3. Tools execute with real storage
 * 4. Results flow back through agent
 */

import { createProvider } from '../src/core/llm-provider'
import { agentLoop } from '../src/core/agent-loop'
import { createKBToolsRegistry } from '../src/tools/kb-tools-registry'
import fs from 'fs'
import path from 'path'

const TEST_DIR = path.join(process.cwd(), 'sessions', 'test-functional')

async function runFunctionalTest() {
  console.log('🧪 FUNCTIONAL TEST: Agent Loop with Tool Execution\n')

  // Setup: Clean test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true })
  }

  // Create provider from environment
  const provider = createProvider({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
  })

  // Create tools registry for this test
  const toolExecutor = createKBToolsRegistry(TEST_DIR)

  console.log(`📋 Registered tools: ${toolExecutor.getTools().map(t => t.name).join(', ')}\n`)

  // Run agent loop with a query that should exercise both tools
  const query = `You are a KB assistant. Do these two things:
1. Write a document titled "Test Agent Loop" with content "This document was created by the agent during functional testing."
2. Read back the document you just created to confirm it exists.
Report what you did.`

  console.log(`📝 Query:\n"${query}"\n`)
  console.log(`⏳ Running agent loop...\n`)

  let eventCount = 0
  let toolCalls = 0
  let documentWrote = false
  let documentRead = false

  for await (const event of agentLoop(query, provider, toolExecutor)) {
    eventCount++

    switch (event.type) {
      case 'text':
        console.log(`💬 Agent: ${event.content}`)
        break
      case 'tool_start':
        toolCalls++
        console.log(`🔨 Tool called: ${event.toolName} (${event.toolUseId})`)
        if (event.toolName === 'write_document') documentWrote = true
        if (event.toolName === 'read_documents') documentRead = true
        break
      case 'tool_result':
        console.log(
          `✅ Tool result: ${JSON.stringify(event.result).slice(0, 150)}${JSON.stringify(event.result).length > 150 ? '...' : ''}`
        )
        break
      case 'metadata':
        console.log(`📊 Tokens: ${event.usage.inputTokens} in, ${event.usage.outputTokens} out`)
        break
      case 'done':
        console.log(`\n✨ Agent done: ${event.reason}`)
        break
      case 'error':
        console.error(`❌ Agent error: ${event.error.message}`)
        break
    }
  }

  console.log(`\n📈 Summary:
  - Total events: ${eventCount}
  - Tool calls: ${toolCalls}
  - write_document called: ${documentWrote ? '✅' : '❌'}
  - read_documents called: ${documentRead ? '✅' : '❌'}`)

  // Verify test results
  const documentsExist = fs.existsSync(path.join(TEST_DIR, 'test-agent-loop.md'))
  console.log(`\n📁 Artifact verification:
  - Test document exists on disk: ${documentsExist ? '✅' : '❌'}`)

  if (documentsExist) {
    const content = fs.readFileSync(path.join(TEST_DIR, 'test-agent-loop.md'), 'utf-8')
    console.log(`\n📄 Document content (first 200 chars):\n${content.slice(0, 200)}...`)
  }

  // Cleanup
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true })
  }

  // Exit code based on success
  const success = toolCalls >= 2 && documentWrote && documentRead
  if (success) {
    console.log(`\n✅ FUNCTIONAL TEST PASSED: Full end-to-end agent + tools flow works!\n`)
    process.exit(0)
  } else {
    console.log(
      `\n❌ FUNCTIONAL TEST INCOMPLETE: Expected tool calls but got ${toolCalls}. Agent may have responded without using tools.\n`
    )
    process.exit(1)
  }
}

runFunctionalTest().catch(err => {
  console.error('❌ Test failed with error:', err)
  process.exit(1)
})
