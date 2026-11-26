/**
 * The file system's own id of a file, as text: the NTFS file id (`ino`, 64 bits, read as a bigint so no digit is lost) with the volume's number
 * (`dev`), so two volumes of one laptop never share an id. Null when the system gives none (ino 0). Read from the same `lstat` the listing
 * already does: no file is opened. Only trusted on NTFS (laptop, OneDrive); callers store it only there.
 */
export function fsIdOf(st: { dev: bigint; ino: bigint }): string | null {
  if (st.ino === 0n) return null;
  return `${st.dev.toString(16)}-${st.ino.toString(16)}`;
}
