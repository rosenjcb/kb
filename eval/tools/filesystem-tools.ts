import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export interface FilesystemToolResult {
  content?: string
  entries?: string[]
  lines?: string[]
  error?: string
  contentLengthChars?: number
}

/** Read a file at an absolute path. Returns UTF-8 content. */
export function readFile(filePath: string): FilesystemToolResult {
  try {
    const content = readFileSync(filePath, 'utf8')
    return { content, contentLengthChars: content.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** List names of entries in a directory. */
export function listDirectory(dirPath: string): FilesystemToolResult {
  try {
    const entries = readdirSync(dirPath).sort()
    return { entries }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Search file contents for lines matching a pattern (cross-platform, no execSync). */
export function searchFileContents(filePath: string, pattern: string): FilesystemToolResult {
  try {
    const content = readFileSync(filePath, 'utf8')
    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'i')
    } catch {
      // Fall back to literal string match if pattern is invalid regex
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      regex = new RegExp(escaped, 'i')
    }
    const lines = content
      .split('\n')
      .filter(line => regex.test(line))
    return { lines, contentLengthChars: content.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Tool definitions for Condition N (raw filesystem, no kb tools). */
export const FILESYSTEM_TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given absolute path.',
    schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to read.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List the names of entries in a directory.',
    schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_file_contents',
    description: 'Search a file for lines matching a pattern (regex or literal).',
    schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file to search.',
        },
        pattern: {
          type: 'string',
          description: 'Pattern to search for (regex or literal string).',
        },
      },
      required: ['path', 'pattern'],
    },
  },
] as const

export type FilesystemToolName = 'read_file' | 'list_directory' | 'search_file_contents'

/** Dispatch a filesystem tool call by name. */
export function dispatchFilesystemTool(
  name: FilesystemToolName,
  args: Record<string, string>
): FilesystemToolResult {
  switch (name) {
    case 'read_file':
      return readFile(args.path ?? '')
    case 'list_directory':
      return listDirectory(args.path ?? '')
    case 'search_file_contents':
      return searchFileContents(args.path ?? '', args.pattern ?? '')
    default:
      return { error: `Unknown filesystem tool: ${String(name)}` }
  }
}

/** Format filesystem tool definitions as a system-prompt block for Condition N. */
export function buildFilesystemToolsPrompt(repoPath: string): string {
  const toolsJson = JSON.stringify(FILESYSTEM_TOOL_DEFINITIONS, null, 2)
  return `<filesystem-tools>
You have access to the following filesystem tools to explore the repository at ${repoPath}.
Use these tools to read files and directories. No other tools are available.

${toolsJson}
</filesystem-tools>`
}
