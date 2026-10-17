export function buildPickerUrl(origin: string, authorizationId: string): string {
  return new URL(`/picker/${encodeURIComponent(authorizationId)}`, origin).toString();
}
