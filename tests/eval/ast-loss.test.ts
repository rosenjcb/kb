import { beforeAll, describe, expect, it } from 'vitest'
import { computeAstLoss, initAstLossParser } from '../../eval/losses/ast-loss'
import type { AstLossParser } from '../../eval/losses/ast-loss'

let ctx: AstLossParser

// WASM initialization is slow — use a generous timeout for the beforeAll.
beforeAll(async () => {
  ctx = await initAstLossParser()
}, 30_000)

describe('computeAstLoss — TypeScript', () => {
  it('Given identical snippets, returns 0.0', async () => {
    const src = 'export function foo(): void {}\nexport class Bar {}'
    expect(await computeAstLoss(src, src, 'ts', ctx)).toBe(0)
  })

  it('Given completely disjoint named exports, returns 1.0', async () => {
    const a = 'export function foo(): void {}'
    const b = 'export class Xyz {}'
    // {function_declaration:foo} vs {class_declaration:Xyz} — no overlap
    expect(await computeAstLoss(a, b, 'ts', ctx)).toBe(1)
  })

  it('Given one extra export in candidate, returns partial loss', async () => {
    const a = 'export function foo(): void {}\nexport function bar(): void {}'
    const b = 'export function foo(): void {}'
    const loss = await computeAstLoss(a, b, 'ts', ctx)
    // intersection=1 {foo}, union=2 {foo,bar} → 1 - 1/2 = 0.5
    expect(loss).toBeCloseTo(0.5)
  })

  it('Given unsupported language, returns 1.0', async () => {
    expect(await computeAstLoss('anything', 'anything', 'cobol', ctx)).toBe(1.0)
  })

  it('Given interface declaration, it is included in the node set', async () => {
    const src = 'export interface Foo { bar: string }'
    expect(await computeAstLoss(src, src, 'ts', ctx)).toBe(0)
  })
})

describe('computeAstLoss — Python', () => {
  it('Given identical Python snippets, returns 0.0', async () => {
    const src = 'def foo():\n    pass\n\nclass Bar:\n    pass'
    expect(await computeAstLoss(src, src, 'python', ctx)).toBe(0)
  })

  it('Given Python snippets with one missing function, returns partial loss', async () => {
    const a = 'def foo():\n    pass\n\ndef bar():\n    pass'
    const b = 'def foo():\n    pass'
    const loss = await computeAstLoss(a, b, 'python', ctx)
    expect(loss).toBeGreaterThan(0)
    expect(loss).toBeLessThan(1)
  })
})
