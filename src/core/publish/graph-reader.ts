import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { kbIndexDbPath } from '../../tools/graph-query-expansion'
import type { JekyllGraphPayload } from './jekyll-sync'

export async function readPublishedGraph(baseDir: string): Promise<JekyllGraphPayload | undefined> {
  const dbPath = kbIndexDbPath(baseDir)
  if (!existsSync(dbPath)) return undefined
  const db = new Database(dbPath, { readonly: true })
  try {
    const allRelationships = db
      .prepare(
        `SELECT subject AS fromId, predicate AS type, object AS toId FROM facts
         WHERE tombstoned_at IS NULL
         LIMIT 5000`
      )
      .all() as Array<{ fromId: string; type: string; toId: string }>

    const entityIds = new Set<string>()
    for (const r of allRelationships) {
      entityIds.add(r.fromId)
      entityIds.add(r.toId)
    }

    const entities = [...entityIds].map(id => ({ id, name: id }))
    return { generatedAt: new Date().toISOString(), entities, relationships: allRelationships }
  } finally {
    db.close()
  }
}
