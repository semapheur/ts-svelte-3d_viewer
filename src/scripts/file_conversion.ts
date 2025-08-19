import * as fs from "node:fs"
import os from "node:os"
import * as path from "node:path"
import AdmZip from "adm-zip"
import obj2gltf from "obj2gltf"

import { findFiles } from "../lib/fs_utils"

function extractZip(zipPath: string, targetDir: string) {
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(targetDir, true)
}

export async function convertObjZipsToGlb(
  zipFolder: string,
  outputFolder: string,
) {
  fs.mkdirSync(outputFolder, { recursive: true })

  const zipFiles = fs
    .readdirSync(zipFolder)
    .filter((f) => f.toLowerCase().endsWith(".zip"))

  for (const outerZip of zipFiles) {
    const outerZipPath = path.join(zipFolder, outerZip)
    console.log(`Processing ${outerZip}...`)

    const tmpOuter = fs.mkdtempSync(path.join(os.tmpdir(), "outer-"))
    extractZip(outerZipPath, tmpOuter)

    const innerZips = findFiles(tmpOuter, ".zip")
    if (innerZips.length === 0) {
      console.warn(`No inner zip found in ${outerZip}`)
      continue
    }

    for (const innerZip of innerZips) {
      const tmpInner = fs.mkdtempSync(path.join(os.tmpdir(), "inner-"))
      extractZip(innerZip, tmpInner)

      const objFiles = findFiles(tmpInner, ".obj")
      if (objFiles.length === 0) {
        console.warn(`No .obj files found in ${innerZip}`)
        continue
      }

      for (const objFile of objFiles) {
        const baseName = path.basename(objFile, ".obj") + ".glb"
        const outPath = path.join(outputFolder, baseName)

        try {
          const glbBuffer = await obj2gltf(objFile, { binary: true })
          fs.writeFileSync(outPath, glbBuffer)
          console.log(`Saved ${outPath}`)
        } catch (err) {
          console.error(`Failed to convert ${objFile}:`, err)
        }
      }
    }
  }
}

convertObjZipsToGlb("../models_obj", "../models_glb")
