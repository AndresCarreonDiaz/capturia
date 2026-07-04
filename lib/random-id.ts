// A base36 [0-9a-z] token from the CSPRNG. Unlike crypto.randomUUID, which is
// only defined in a SECURE context, crypto.getRandomValues works over plain
// HTTP too. That matters because audience voting is reached over a plain-HTTP
// LAN IP (studio and phones both), where randomUUID throws and would crash the
// page. The output satisfies the vote store's ROOM_ID_RE and KEY_RE
// (^[a-z0-9-]{8,64}$ / {8,32}), so it works for room slugs, host keys, and
// viewer ids alike.
export function randomToken(len = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}
