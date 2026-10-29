export function exportFilename(projectName: string): string {
  const name = projectName
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${name || "video"}.mp4`;
}
