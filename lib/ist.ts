const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** `YYYY-MM-DD HH:mm:ss` in Asia/Kolkata (fixed +05:30, no DST). Kept free of imports so any module can use it cheaply. */
export function formatIST(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}
