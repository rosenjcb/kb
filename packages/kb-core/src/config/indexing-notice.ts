/** User-facing message when deprecated client indexing commands are invoked. */
export const INDEXING_SERVER_MANAGED_NOTICE = [
  'Indexing is managed by kb-server — not the kb client.',
  '',
  'Configure git repos on the server:',
  '  export KB_GIT_REPOS=https://github.com/org/repo',
  '  export KB_BASE=my-base          # optional',
  '  kb-server start',
  '',
  'The server clones, indexes, and re-indexes on a schedule (KB_REINDEX_INTERVAL).',
  'Point the client at the server with --host or KB_HOST / KB_SERVER_URL.',
].join('\n')

export function uninitializedBaseNotice(baseName: string): string {
  return [
    `Base "${baseName}" is selected but has no index yet on this server.`,
    '',
    'Ask your kb-server operator to add repos (KB_GIT_REPOS) or pick another base:',
    '  kb base use <base>',
  ].join('\n')
}
