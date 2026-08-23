/** How to configure git-repo indexing on kb-server. */
export const INDEXING_SERVER_MANAGED_NOTICE = [
  'Git repos are indexed on kb-server.',
  '',
  'On the server host:',
  '  export KB_SERVER_BASE_GIT_REPOS=https://github.com/org/repo',
  '  export KB_SERVER_BASE_NAME=my-base          # optional',
  '  kb-server start',
  '',
  'The server clones, indexes, and re-indexes on a schedule (KB_REINDEX_INTERVAL).',
  'Connect the client with --host or KB_HOST / KB_CONNECTION_STRING.',
].join('\n')

export function uninitializedBaseNotice(baseName: string): string {
  return [
    `Base "${baseName}" is selected but has no index yet on this server.`,
    '',
    'Ask your kb-server operator to add repos (KB_SERVER_BASE_GIT_REPOS) or pick another base:',
    '  kb base use <base>',
  ].join('\n')
}
