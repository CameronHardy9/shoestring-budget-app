// Saves a Blob as a file through a temporary object URL (CSV export, recovery
// codes). The URL is revoked later, not right after click(): iOS Safari can
// cancel a download whose URL was already revoked.
export const REVOKE_AFTER_MS = 60_000;

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_AFTER_MS);
}
