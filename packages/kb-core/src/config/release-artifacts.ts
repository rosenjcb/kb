/** GitHub Releases asset URLs — keep in sync with `scripts/install-release.sh`. */
export const KB_RELEASE_DOWNLOAD_BASE =
  'https://github.com/rosenjcb/kb/releases/latest/download' as const

export const KB_CLIENT_RELEASE_TARBALL_URL =
  `${KB_RELEASE_DOWNLOAD_BASE}/kb-client-node24.tgz` as const

export const KB_SERVER_RELEASE_TARBALL_URL =
  `${KB_RELEASE_DOWNLOAD_BASE}/kb-server-node24.tgz` as const

export const KB_RELEASE_INSTALLER_URL = `${KB_RELEASE_DOWNLOAD_BASE}/install-kb.sh` as const
