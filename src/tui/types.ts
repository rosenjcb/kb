export type TuiMode = 'shell' | 'chat'

export type EntryType =
  | 'command'
  | 'result'
  | 'error'
  | 'info'
  | 'chat-you'
  | 'chat-assistant'

export interface HistoryEntry {
  id: string
  type: EntryType
  content: string
  loading?: boolean
}
