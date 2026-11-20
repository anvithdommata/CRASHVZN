const files = new Map<string, { fileName: string; bytes: Uint8Array }>();

export function putSplatFile(id: string, file: { fileName: string; bytes: Uint8Array }) {
  files.set(id, file);
}

export function getSplatFile(id: string) {
  return files.get(id);
}

const SPLAT_EXT = /\.(spz|ply|splat|ksplat|sog|zip)$/i;

export function isSplatFile(name: string) {
  return SPLAT_EXT.test(name);
}

export function dropSplatFile(id: string) {
  files.delete(id);
}
