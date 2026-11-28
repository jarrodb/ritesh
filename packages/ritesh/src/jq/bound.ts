// Only the first maxLines lines (and maxChars characters) go back to the
// page, so a huge result never crosses into it.
export function bound(stdout: string, maxLines: number, maxChars: number): { text: string; cut: boolean } {
  let end = 0
  for (let line = 0; line < maxLines; line++) {
    const nl = stdout.indexOf("\n", end)
    if (nl === -1) {
      end = stdout.length
      break
    }
    end = nl + 1
  }
  const cut = end < stdout.length || end > maxChars
  return { text: stdout.slice(0, Math.min(end, maxChars)), cut }
}
