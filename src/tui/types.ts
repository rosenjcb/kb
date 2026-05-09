export type TuiMode = 'chat'

export type EntryType =
  | 'banner'
  | 'command'
  | 'result'
  | 'error'
  | 'info'
  | 'chat-you'
  | 'chat-assistant'
  | 'chat-meta'

export interface HistoryEntry {
  id: string
  type: EntryType
  content: string
  loading?: boolean
}
