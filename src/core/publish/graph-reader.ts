import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { kbIndexDbPath } from '../../tools/graph-query-expansion'
import type { JekyllGraphPayload } from './jekyll-sync'

export async function readPublishedGraph(baseDir: string): Promise<JekyllGraphPayload | undefined> {
  const dbPath = kbIndexDbPath(baseDir)
  if (!existsSync(dbPath)) return undefined
  const db = new Database(dbPath, { readonly: true })
  try {
    const entities = db
      .prepare(
        `SELECT DISTINCT subject AS id, subject AS name FROM facts
         WHERE tombstoned_at IS NULL AND subject != 'kb' AND predicate != 'asserts'`
      )
      .all() as Array<{ id: string; name: string }>
    const allRelationships = db
      .prepare(
        `SELECT subject AS fromId, predicate AS type, object AS toId FROM facts
         WHERE tombstoned_at IS NULL AND predicate != 'asserts' AND subject != 'kb'
         LIMIT 2000`
      )
      .all() as Array<{ fromId: string; type: string; toId: string }>
    const entityIds = new Set(entities.map(e => e.id))
    const relationships = allRelationships.filter(r => entityIds.has(r.fromId) && entityIds.has(r.toId))
    return { generatedAt: new Date().toISOString(), entities, relationships }
  } finally {
    db.close()
  }
}
