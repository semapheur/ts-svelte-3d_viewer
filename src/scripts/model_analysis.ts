import * as fs from "node:fs"
import { NodeIO } from "@gltf-transform/core"
import { findFiles } from "../lib/fs_utils"

async function extractMeshNames(path: string) {
  const glbFiles = findFiles(path, ".glb")

  if (glbFiles.length === 0) {
    console.warn(`No .glb files found in ${path}`)
    return
  }

  const meshNames = new Set<string>()
  const meshAttributes = new Set<string>()
  const io = new NodeIO()
  const suffix = /(_[0-9]+)+/g

  for (const glbFile of glbFiles) {
    const document = await io.read(glbFile)
    document
      .getRoot()
      .listMeshes()
      .forEach((mesh) => {
        let name = mesh.getName()
        if (name) {
          name = name.replace(suffix, "")
          meshNames.add(name)
        }
        console.log(mesh.listPrimitives())
        mesh.listPrimitives().forEach((primitive) => {
          primitive.listAttributes().map((attr) => {
            meshAttributes.add(attr.getName())
          })
        })
      })
  }
  console.log(meshAttributes)

  if (meshNames.size === 0) {
    console.warn(`No mesh names found in ${path}`)
    return
  }

  fs.writeFileSync(
    "mesh_names.txt",
    Array.from(meshNames).sort().join("\n"),
    "utf8",
  )
}

await extractMeshNames("../models_glb")
