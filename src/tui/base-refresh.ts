export async function awaitRefreshThenStart(
  refreshBase: () => Promise<unknown>,
  startSession: () => void,
): Promise<void> {
  await refreshBase()
  startSession()
}
