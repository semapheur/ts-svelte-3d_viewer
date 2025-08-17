import * as fs from "node:fs"
import * as path from "node:path"

export function findFiles(dir: string, ext: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  let files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files = files.concat(findFiles(fullPath, ext))
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(ext.toLowerCase())
    ) {
      files.push(fullPath)
    }
  }
  return files
}