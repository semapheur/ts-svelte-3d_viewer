import { uv } from "three/tsl"

interface Vertex {
  x: number
  y: number
  z: number
}

interface Face {
  vertices: number[]
  normal?: Vertex
  uv?: number[][]
}

interface MeshData {
  vertices: Vertex[]
  faces: Face[]
  normals?: Vertex[]
  uvs?: number[][]
  name?: string
}

interface RepairOptions {
  mergeTolerance?: number
  removeLooseVertices?: boolean
  removeDegenerateFaces?: boolean
  fixNonManifoldEdges?: boolean
  ensureManifold?: boolean
  onProgress?: (progress: number, operation: string) => void
}

interface RepairResults {
  mergedVertices: number
  removedLooseVertices: number
  removedDegenerateFaces: number
  fixedNonManifoldEdges: number
  totalIssuesFound: number
  totalIssuesFixed: number
}

export class ObjGeometryRepairer {
  private tolerance: number

  constructor(tolerance: number = 0.000001) {
    this.tolerance = tolerance
  }

  parseObjFiles(objContent: string): MeshData[] {
    const lines = objContent.split("\n")
    const vertices: Vertex[] = []
    const normals: Vertex[] = []
    const uvs: number[][] = []
    const faces: Face[] = []

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)

      if (parts[0] === "v") {
        vertices.push({
          x: parseFloat(parts[1]),
          y: parseFloat(parts[2]),
          z: parseFloat(parts[3]),
        })
      } else if (parts[0] === "vn") {
        normals.push({
          x: parseFloat(parts[1]),
          y: parseFloat(parts[2]),
          z: parseFloat(parts[3]),
        })
      } else if (parts[0] === "vt") {
        uvs.push([parseFloat(parts[1]), parseFloat(parts[2])])
      } else if (parts[0] === "f") {
        const faceVertices: number[] = []
        const faceUvs: number[][] = []

        for (let i = 1; i < parts.length; i++) {
          const vertexData = parts[i].split("/")
          const vertexIndex = parseInt(vertexData[1], 10) - 1
          faceVertices.push(vertexIndex)

          if (vertexData.length > 1 && vertexData[1]) {
            const uvIndex = parseInt(vertexData[1], 10) - 1
            if (uvs[uvIndex]) {
              faceUvs.push(uvs[uvIndex])
            }
          }

          if (faceVertices.length >= 3) {
            faces.push({
              vertices: faceVertices,
              uv: faceUvs.length > 0 ? faceUvs : undefined,
            })
          }
        }
      }
    }

    return [
      {
        vertices,
        faces,
        normals: normals.length > 0 ? normals : undefined,
        uvs: uvs.length > 0 ? uvs : undefined,
      },
    ]
  }

  repairMeshData(
    meshData: MeshData,
    options: RepairOptions = {},
  ): RepairResults {
    const {
      mergeTolerance = this.tolerance,
      removeLooseVertices = true,
      removeDegenerateFaces = true,
      fixNonManifoldEdges = true,
      onProgress,
    } = options

    const results: RepairResults = {
      mergedVertices: 0,
      removedLooseVertices: 0,
      removedDegenerateFaces: 0,
      fixedNonManifoldEdges: 0,
      totalIssuesFound: 0,
      totalIssuesFixed: 0,
    }

    onProgress?.(10, "Merging duplicate vertices")
    results.mergedVertices = this.mergeVertices(meshData, mergeTolerance)

    if (removeDegenerateFaces) {
      onProgress?.(30, "Removing degenerate faces")
      results.removedDegenerateFaces = this.removeDegenerateFaces(meshData)
    }

    if (fixNonManifoldEdges) {
      onProgress?.(50, "Fixing non-manifold edges")
      results.fixedNonManifoldEdges = this.fixNonManifoldEdges(meshData)
    }

    if (removeLooseVertices) {
      onProgress?.(70, "Removing loose vertices")
      results.removedLooseVertices = this.removeLooseVertices(meshData)
    }

    onProgress?.(90, "Recalculating normals")
    this.recalculateNormals(meshData)

    onProgress?.(100, "Geometry repair complete")
    results.totalIssuesFound =
      results.mergedVertices +
      results.removedDegenerateFaces +
      results.fixedNonManifoldEdges +
      results.removedLooseVertices
    results.totalIssuesFixed = results.totalIssuesFound

    return results
  }

  private mergeVertices(meshData: MeshData, tolerance: number): number {
    const vertexMap = new Map<string, number>()
    const newVertices: Vertex[] = []
    const indexRemap = new Map<number, number>()
    let mergedCount = 0

    for (let i = 0; i < meshData.vertices.length; i++) {
      const v = meshData.vertices[i]
      const key = `${Math.round(v.x / tolerance) * tolerance},${Math.round(v.y / tolerance) * tolerance},${Math.round(v.z / tolerance) * tolerance}`

      if (vertexMap.has(key)) {
        indexRemap.set(i, vertexMap.get(key)!)
        mergedCount++
      } else {
        const newIndex = newVertices.length
        vertexMap.set(key, newIndex)
        indexRemap.set(i, newIndex)
        newVertices.push(v)
      }
    }

    for (const face of meshData.faces) {
      for (let i = 0; i < face.vertices.length; i++) {
        face.vertices[i] = indexRemap.get(face.vertices[i]) ?? face.vertices[i]
      }
    }

    meshData.vertices = newVertices
    return mergedCount
  }

  private removeDegenerateFaces(meshData: MeshData): number {
    const validFaces: Face[] = []
    let removedCount = 0

    for (const face of meshData.faces) {
      if (this.isDegenerateFace(face, meshData.vertices)) {
        removedCount++
      } else {
        validFaces.push(face)
      }
    }

    meshData.faces = validFaces
    return removedCount
  }

  private isDegenerateFace(face: Face, vertices: Vertex[]): boolean {
    if (face.vertices.length < 3) return true

    const uniqueIndices = new Set(face.vertices)
    if (uniqueIndices.size < 3) return true

    const v0 = vertices[face.vertices[0]]
    const v1 = vertices[face.vertices[1]]
    const v2 = vertices[face.vertices[2]]

    const edge1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z }
    const edge2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z }

    const cross = {
      x: edge1.y * edge2.z - edge1.z * edge2.y,
      y: edge1.z * edge2.x - edge1.x * edge2.z,
      z: edge1.x * edge2.y - edge1.y * edge2.x,
    }

    const lengthSq = cross.x * cross.x + cross.y * cross.y + cross.z * cross.z
    return lengthSq < this.tolerance * this.tolerance
  }

  private fixNonManifoldEdges(meshData: MeshData): number {
    const edgeCount = new Map<string, number>()
    const facesToRemove = new Set<number>()

    for (let faceIndex = 0; faceIndex < meshData.faces.length; faceIndex++) {
      const face = meshData.faces[faceIndex]

      for (let i = 0; i < face.vertices.length; i++) {
        const v1 = face.vertices[i]
        const v2 = face.vertices[(i + 1) % face.vertices.length]
        const edgeKey = `${Math.min(v1, v2)}-${Math.max(v1, v2)}`

        const count = edgeCount.get(edgeKey) || 0
        edgeCount.set(edgeKey, count + 1)
      }
    }

    let removedCount = 0
    for (let faceIndex = 0; faceIndex < meshData.faces.length; faceIndex++) {
      const face = meshData.faces[faceIndex]
      let hasNonManifoldEdge = false

      for (let i = 0; i < face.vertices.length; i++) {
        const v1 = face.vertices[i]
        const v2 = face.vertices[(i + 1) % face.vertices.length]
        const edgeKey = `${Math.min(v1, v2)}-${Math.max(v1, v2)}`

        if ((edgeCount.get(edgeKey) || 0) > 2) {
          hasNonManifoldEdge = true
          break
        }
      }

      if (hasNonManifoldEdge) {
        facesToRemove.add(faceIndex)
        removedCount++
      }
    }

    meshData.faces = meshData.faces.filter(
      (_, index) => !facesToRemove.has(index),
    )
    return removedCount
  }

  private removeLooseVertices(meshData: MeshData): number {
    const usedVertices = new Set<number>()

    for (const face of meshData.faces) {
      for (const vertex of face.vertices) {
        usedVertices.add(vertex)
      }
    }

    const newVertices: Vertex[] = []
    const indexRemap = new Map<number, number>()
    let removedCount = 0

    for (let i = 0; i < meshData.vertices.length; i++) {
      if (usedVertices.has(i)) {
        indexRemap.set(i, newVertices.length)
        newVertices.push(meshData.vertices[i])
      } else {
        removedCount++
      }
    }

    for (const face of meshData.faces) {
      for (let i = 0; i < face.vertices.length; i++) {
        face.vertices[i] = indexRemap.get(face.vertices[i]) ?? face.vertices[i]
      }
    }

    meshData.vertices = newVertices
    return removedCount
  }

  private recalculateNormals(meshData: MeshData): void {
    const vertexNormals: Vertex[] = new Array(meshData.vertices.length).fill({
      x: 0,
      y: 0,
      z: 0,
    })

    for (const face of meshData.faces) {
      if (face.vertices.length < 3) continue

      const v0 = meshData.vertices[face.vertices[0]]
      const v1 = meshData.vertices[face.vertices[1]]
      const v2 = meshData.vertices[face.vertices[2]]

      const edge1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z }
      const edge2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z }

      const normal = {
        x: edge1.y * edge2.z - edge1.z * edge2.y,
        y: edge1.z * edge2.x - edge1.x * edge2.z,
        z: edge1.x * edge2.y - edge1.y * edge2.x,
      }

      const length = Math.sqrt(
        normal.x * normal.x + normal.y * normal.y + normal.z * normal.z,
      )

      if (length > 0) {
        normal.x /= length
        normal.y /= length
        normal.z /= length
      }

      for (const vertexIndex of face.vertices) {
        vertexNormals[vertexIndex].x += normal.x
        vertexNormals[vertexIndex].y += normal.y
        vertexNormals[vertexIndex].z += normal.z
      }
    }
    for (const normal of vertexNormals) {
      const length = Math.sqrt(
        normal.x * normal.x + normal.y * normal.y + normal.z * normal.z,
      )
      if (length > 0) {
        normal.x /= length
        normal.y /= length
        normal.z /= length
      }
    }

    meshData.normals = vertexNormals
  }

  meshDataToObj(meshData: MeshData): string {
    const lines: string[] = []

    for (const vertex of meshData.vertices) {
      lines.push(`v ${vertex.x} ${vertex.y} ${vertex.z}`)
    }

    if (meshData.normals) {
      for (const normal of meshData.normals) {
        lines.push(`vn ${normal.x} ${normal.y} ${normal.z}`)
      }
    }

    if (meshData.uvs) {
      for (const uv of meshData.uvs) {
        lines.push(`vt ${uv[0]} ${uv[1]}`)
      }
    }

    for (const face of meshData.faces) {
      const faceText = face.vertices.map((v) => (v + 1).toString()).join(" ")
      lines.push(`f ${faceText}`)
    }

    return lines.join("\n")
  }
}
