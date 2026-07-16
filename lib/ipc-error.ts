// Unwraps Electron IPC rejections for display. When a main-process handler
// throws, ipcRenderer.invoke() rejects in the renderer with the original
// message re-wrapped as "Error invoking remote method '<channel>': Error:
// <message>" (no inner "Error: " when main threw a non-Error). Surfacing
// that verbatim shows the user IPC plumbing instead of what went wrong, so
// this strips the wrapper down to the message the handler actually threw.
// Framework-free so vitest pins the shapes (lib/ipc-error.test.ts).

export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
