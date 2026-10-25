/** Content scripts share the extension id, so id/name alone never authorize host commands. */
export function isSidePanelSender(sender: unknown, extensionId: string, panelUrl: string): boolean {
  if (typeof sender !== 'object' || sender === null) return false;
  const value = sender as Record<string, unknown>;
  return value.id === extensionId && value.tab === undefined && value.url === panelUrl;
}
