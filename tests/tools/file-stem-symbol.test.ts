import { fileStem } from '@kb/core/tools/file-stem-symbol.js'
import { describe, expect, it } from 'vitest'

describe('fileStem', () => {
  it('[TC-1WQ0] skips generic role stems such as index, main, and utils', () => {
    expect(fileStem('src/index.ts')).toBeUndefined()
    expect(fileStem('cmd/main.go')).toBeUndefined()
    expect(fileStem('lib/utils.ts')).toBeUndefined()
    expect(fileStem('src/scope-inference.ts')).toBe('scope-inference')
  })
})
