import * as fs from "node:fs"
import os from "node:os"
import * as path from "node:path"
import AdmZip from "adm-zip"
import obj2gltf from "obj2gltf"

import { findFiles } from "../lib/fs_utils"
import {
  ObjGeometryRepairer,
  type RepairOptions,
  type RepairResults,
} from "../lib/geometry_fix_obj"

function extractZip(zipPath: string, targetDir: string) {
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(targetDir, true)
}

async function convertObjToGlb(objFile: string, outputPath: string) {
  try {
    const glbBuffer = await obj2gltf(objFile, { binary: true })
    fs.writeFileSync(outputPath, glbBuffer)
    console.log(`Saved ${outputPath}`)
  } catch (error) {
    console.error(`Failed to convert ${objFile}:`, error)
  }
}

async function convertObjToGlbWithRepair(
  objFile: string,
  outputPath: string,
  options: RepairOptions = {},
): Promise<RepairResults | null> {
  const objContent = fs.readFileSync(objFile, "utf-8")
  const repairer = new ObjGeometryRepairer()
  const meshDataArray = repairer.parseObjFiles(objContent)

  const totalResults: RepairResults = {
    mergedVertices: 0,
    removedLooseVertices: 0,
    removedDegenerateFaces: 0,
    fixedNonManifoldEdges: 0,
    totalIssuesFound: 0,
    totalIssuesFixed: 0,
  }

  for (let i = 0; i < meshDataArray.length; i++) {
    const meshData = meshDataArray[i]
    const results = repairer.repairMeshData(meshData, {
      ...options,
      onProgress: (progress, operation) => {
        console.log(`    ${operation}: ${progress.toFixed(1)}%`)
      },
    })

    totalResults.mergedVertices += results.mergedVertices
    totalResults.removedLooseVertices += results.removedLooseVertices
    totalResults.removedDegenerateFaces += results.removedDegenerateFaces
    totalResults.fixedNonManifoldEdges += results.fixedNonManifoldEdges
    totalResults.totalIssuesFound += results.totalIssuesFound
    totalResults.totalIssuesFixed += results.totalIssuesFixed
  }

  const tempObjPath = objFile.replace(".obj", "_repaired.obj")
  const repairedObjContent = meshDataArray
    .map((mesh) => repairer.meshDataToObj(mesh))
    .join("\n")
  fs.writeFileSync(tempObjPath, repairedObjContent)

  try {
    const glbBuffer = await obj2gltf(tempObjPath, { binary: true })
    fs.writeFileSync(outputPath, glbBuffer)

    console.log(`Converted and repaired: ${path.basename(outputPath)}`)
    if (totalResults.totalIssuesFixed > 0) {
      console.log(`Fixed ${totalResults.totalIssuesFixed} geometry issues:`)
      if (totalResults.mergedVertices > 0)
        console.log(
          `- Merged ${totalResults.mergedVertices} duplicate vertices`,
        )
      if (totalResults.removedDegenerateFaces > 0)
        console.log(
          `- Removed ${totalResults.removedDegenerateFaces} degenerate faces`,
        )
      if (totalResults.fixedNonManifoldEdges > 0)
        console.log(
          `- Fixed ${totalResults.fixedNonManifoldEdges} non-manifold edges`,
        )
      if (totalResults.removedLooseVertices > 0)
        console.log(
          `- Removed ${totalResults.removedLooseVertices} loose vertices`,
        )
    }

    return totalResults
  } catch (error) {
    console.error(`Failed to convert ${objFile}: ${error}`)
    return null
  } finally {
    if (fs.existsSync(tempObjPath)) {
      fs.unlinkSync(tempObjPath)
    }
  }
}

export async function convertObjZipsToGlb(
  zipFolder: string,
  outputFolder: string,
  repair: boolean = false,
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

        if (repair) {
          await convertObjToGlbWithRepair(objFile, outPath)
        } else {
          await convertObjToGlb(objFile, outPath)
        }
      }
    }
  }
}

convertObjZipsToGlb("../models_obj", "../models_glb_")
