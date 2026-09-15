export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  const mb = kb / 1024;
  return mb.toFixed(1) + " MB";
}

export function formatKb(kb) {
  return formatBytes(kb * 1024);
}

export function formatMb(mb) {
  return formatBytes(mb * 1024 * 1024);
}
