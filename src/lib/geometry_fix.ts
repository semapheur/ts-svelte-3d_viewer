import * as THREE from "three"

interface MeshData {
  mesh: THREE.Mesh
  name: string
  originalGeometry: THREE.BufferGeometry
}

interface GeometryAnalysis {
  vertices: number
  faces: number
  duplicateVertices: number
  looseVertices: number
  nonManifoldEdges: number
  nonManifoldVertices: number
  degenerateFaces: number
  boundaryEdges: number
  meshName?: string
  meshIndex?: number
}

interface TotalStats {
  meshes: number
  vertices: number
  faces: number
  duplicateVertices: number
  looseVertices: number
  nonManifoldEdges: number
  nonManifoldVertices: number
  degenerateFaces: number
  boundaryEdges: number
  totalIssues?: number
}

interface AnalysisResult {
  totalStats: TotalStats
  meshAnalysis: GeometryAnalysis[]
}

interface RepairOptions {
  mergeTolerance?: number
  onProgress?: (percent: number, operation: string) => void
  skipOperations?: string[]
  ensureManifold?: boolean
}

interface RepairOperation {
  name: string
  fn: () => number | Promise<number>
}

interface RepairResults {
  repairs: Record<string, number>
  finalAnalysis: AnalysisResult
}

export class GeometryRepairer {
  private meshes: MeshData[] = []
  private analysisResults: GeometryAnalysis[] = []

  constructor() {
    this.meshes = []
    this.analysisResults = []
  }

  public extractMeshes(object3D: THREE.Object3D): MeshData[] {
    this.meshes = []

    object3D.traverse((child: THREE.Object3D) => {
      if (this.isMeshWithGeometry(child)) {
        this.meshes.push({
          mesh: child,
          name: child.name || `Mesh_${this.meshes.length}`,
          originalGeometry: child.geometry.clone(),
        })
      }
    })

    console.log(`Found ${this.meshes.length} meshes in the 3D object`)
    return this.meshes
  }

  private isMeshWithGeometry(object: THREE.Object3D): object is THREE.Mesh {
    return (
      object instanceof THREE.Mesh &&
      object.geometry instanceof THREE.BufferGeometry &&
      object.geometry.attributes.position !== undefined
    )
  }

  public analyzeGeometry(object3D: THREE.Object3D): AnalysisResult {
    this.extractMeshes(object3D)
    this.analysisResults = []

    const totalStats: TotalStats = {
      meshes: this.meshes.length,
      vertices: 0,
      faces: 0,
      duplicateVertices: 0,
      looseVertices: 0,
      nonManifoldEdges: 0,
      nonManifoldVertices: 0,
      degenerateFaces: 0,
      boundaryEdges: 0,
    }

    this.meshes.forEach((meshData: MeshData, index: number) => {
      const analysis = this.analyzeSingleMesh(meshData.mesh.geometry)
      analysis.meshName = meshData.name
      analysis.meshIndex = index

      this.analysisResults.push(analysis)

      totalStats.vertices += analysis.vertices
      totalStats.faces += analysis.faces
      totalStats.duplicateVertices += analysis.duplicateVertices
      totalStats.looseVertices += analysis.looseVertices
      totalStats.nonManifoldEdges += analysis.nonManifoldEdges
      totalStats.nonManifoldVertices += analysis.nonManifoldVertices || 0
      totalStats.degenerateFaces += analysis.degenerateFaces || 0
      totalStats.boundaryEdges += analysis.boundaryEdges || 0

      const meshIssues =
        (analysis.duplicateVertices || 0) +
        (analysis.looseVertices || 0) +
        (analysis.nonManifoldEdges || 0) +
        (analysis.nonManifoldVertices || 0) +
        (analysis.degenerateFaces || 0)

      console.log(
        `${meshData.name}: ${analysis.vertices}v, ${analysis.faces}f, ${meshIssues} issues`,
      )
    })

    const totalIssues =
      totalStats.duplicateVertices +
      totalStats.looseVertices +
      totalStats.nonManifoldEdges +
      totalStats.nonManifoldVertices +
      totalStats.degenerateFaces

    totalStats.totalIssues = totalIssues
    console.log(
      `Total analysis: ${totalStats.meshes} meshes, ${totalStats.vertices} vertices, ${totalStats.faces} faces, ${totalIssues} issues`,
    )

    return {
      totalStats,
      meshAnalysis: this.analysisResults,
    }
  }

  private analyzeSingleMesh(geometry: THREE.BufferGeometry): GeometryAnalysis {
    const positionAttribute = geometry.attributes
      .position as THREE.BufferAttribute
    const positions = positionAttribute.array as Float32Array
    const indices = geometry.index?.array as Uint16Array | Uint32Array | null

    const analysis: GeometryAnalysis = {
      vertices: positions.length / 3,
      faces: indices ? indices.length / 3 : positions.length / 9,
      duplicateVertices: 0,
      looseVertices: 0,
      nonManifoldEdges: 0,
      nonManifoldVertices: 0,
      degenerateFaces: 0,
      boundaryEdges: 0,
    }

    // Fast duplicate vertex detection using spatial hashing
    analysis.duplicateVertices = this.countDuplicateVerticesFast(positions)

    if (indices) {
      // Single-pass analysis for optimal performance
      const edgeCount = new Map<number, number>()
      const vertexFaceCount = new Array<number>(analysis.vertices).fill(0)
      const vertexEdgeSet = new Array<Set<number>>(analysis.vertices)

      // Initialize vertex edge sets
      for (let i = 0; i < analysis.vertices; i++) {
        vertexEdgeSet[i] = new Set()
      }

      // Single pass through faces
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i],
          b = indices[i + 1],
          c = indices[i + 2]

        // Quick degenerate face check
        if (a === b || b === c || c === a) {
          analysis.degenerateFaces++
          continue
        }

        // Check for zero-area faces (simplified)
        if (this.isZeroAreaFace(positions, a, b, c)) {
          analysis.degenerateFaces++
          continue
        }

        // Count valid faces
        vertexFaceCount[a]++
        vertexFaceCount[b]++
        vertexFaceCount[c]++

        // Process edges using numeric keys for performance
        const edges = [
          this.getEdgeKey(a, b),
          this.getEdgeKey(b, c),
          this.getEdgeKey(c, a),
        ]

        for (let j = 0; j < 3; j++) {
          const edgeKey = edges[j]
          const count = edgeCount.get(edgeKey) || 0
          edgeCount.set(edgeKey, count + 1)

          // Track vertex connectivity
          const [v1, v2] = this.decodeEdgeKey(edgeKey)
          vertexEdgeSet[v1].add(v2)
          vertexEdgeSet[v2].add(v1)
        }
      }

      // Analyze edge manifoldness in single pass
      let boundaryEdgeCount = 0
      for (const count of edgeCount.values()) {
        if (count === 1) {
          boundaryEdgeCount++
        } else if (count > 2) {
          analysis.nonManifoldEdges++
        }
      }
      analysis.boundaryEdges = boundaryEdgeCount

      // Fast vertex analysis
      for (let i = 0; i < analysis.vertices; i++) {
        if (vertexFaceCount[i] === 0) {
          analysis.looseVertices++
        } else {
          // Simplified non-manifold vertex detection
          const expectedEdges = vertexFaceCount[i]
          const actualEdges = vertexEdgeSet[i].size
          if (actualEdges > expectedEdges + 1) {
            analysis.nonManifoldVertices++
          }
        }
      }
    }

    return analysis
  }

  private countDuplicateVerticesFast(positions: Float32Array): number {
    const tolerance = 0.000001
    const scale = 1 / tolerance
    const vertexSet = new Set<number>()
    let duplicates = 0

    for (let i = 0; i < positions.length; i += 3) {
      // Use a single number as hash key for better performance
      const x = Math.round(positions[i] * scale)
      const y = Math.round(positions[i + 1] * scale)
      const z = Math.round(positions[i + 2] * scale)

      // Combine coordinates into single hash
      const hash = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791)

      if (vertexSet.has(hash)) {
        duplicates++
      } else {
        vertexSet.add(hash)
      }
    }

    return duplicates
  }

  private isZeroAreaFace(
    positions: Float32Array,
    a: number,
    b: number,
    c: number,
  ): boolean {
    const tolerance = 0.000001

    // Get vertex positions
    const ax = positions[a * 3],
      ay = positions[a * 3 + 1],
      az = positions[a * 3 + 2]
    const bx = positions[b * 3],
      by = positions[b * 3 + 1],
      bz = positions[b * 3 + 2]
    const cx = positions[c * 3],
      cy = positions[c * 3 + 1],
      cz = positions[c * 3 + 2]

    // Calculate cross product of two edges
    const abx = bx - ax,
      aby = by - ay,
      abz = bz - az
    const acx = cx - ax,
      acy = cy - ay,
      acz = cz - az

    const crossX = aby * acz - abz * acy
    const crossY = abz * acx - abx * acz
    const crossZ = abx * acy - aby * acx

    // Check if cross product length is below tolerance
    const lengthSq = crossX * crossX + crossY * crossY + crossZ * crossZ
    return lengthSq < tolerance * tolerance
  }

  private getEdgeKey(a: number, b: number): number {
    // Use Cantor pairing function for unique edge keys
    const min = Math.min(a, b)
    const max = Math.max(a, b)
    return ((min + max) * (min + max + 1)) / 2 + max
  }

  private decodeEdgeKey(key: number): [number, number] {
    // Reverse Cantor pairing (simplified for our use case)
    const w = Math.floor((Math.sqrt(8 * key + 1) - 1) / 2)
    const t = (w * w + w) / 2
    const max = key - t
    const min = w - max
    return [min, max]
  }

  public validateManifoldGeometry(object3D: THREE.Object3D): boolean {
    const analysis = this.analyzeGeometry(object3D)

    // Check if geometry is suitable for SVG rendering
    const hasIssues =
      analysis.totalStats.nonManifoldEdges > 0 ||
      analysis.totalStats.nonManifoldVertices > 0 ||
      analysis.totalStats.degenerateFaces > 0 ||
      analysis.totalStats.looseVertices > 0

    if (hasIssues) {
      console.warn(
        "Geometry has manifold issues that may cause SVG rendering problems:",
        {
          nonManifoldEdges: analysis.totalStats.nonManifoldEdges,
          nonManifoldVertices: analysis.totalStats.nonManifoldVertices,
          degenerateFaces: analysis.totalStats.degenerateFaces,
          looseVertices: analysis.totalStats.looseVertices,
        },
      )
      return false
    }

    console.log("Geometry validation passed - suitable for SVG rendering")
    return true
  }

  public ensureManifoldGeometry(
    object3D: THREE.Object3D,
  ): Promise<RepairResults> {
    console.log("Ensuring manifold geometry for SVG compatibility...")

    return this.repairGeometry(object3D, {
      mergeTolerance: 0.000001,
      skipOperations: [], // Don't skip any operations
      ensureManifold: true, // New option for stricter manifold enforcement
    })
  }

  public mergeVertices(
    object3D: THREE.Object3D,
    tolerance: number = 0.000001,
  ): number {
    this.extractMeshes(object3D)
    let totalMerged = 0

    console.log(`Merging vertices for ${this.meshes.length} meshes...`)

    this.meshes.forEach((meshData: MeshData) => {
      const merged = this.mergeVerticesForMesh(meshData.mesh, tolerance)
      totalMerged += merged
      console.log(`${meshData.name}: merged ${merged} duplicate vertices`)
    })

    console.log(`Total merged vertices across all meshes: ${totalMerged}`)
    return totalMerged
  }

  private mergeVerticesForMesh(
    mesh: THREE.Mesh,
    tolerance: number = 0.000001,
  ): number {
    const geometry = mesh.geometry as THREE.BufferGeometry
    const positionAttribute = geometry.attributes
      .position as THREE.BufferAttribute
    const positions = positionAttribute.array as Float32Array
    const normalAttribute = geometry.attributes.normal as
      | THREE.BufferAttribute
      | undefined
    const normals = normalAttribute?.array as Float32Array | null
    const uvAttribute = geometry.attributes.uv as
      | THREE.BufferAttribute
      | undefined
    const uvs = uvAttribute?.array as Float32Array | null
    const indices = geometry.index?.array as Uint16Array | Uint32Array | null

    const vertexMap = new Map<string, number>()
    const newPositions: number[] = []
    const newNormals: number[] | null = normals ? [] : null
    const newUvs: number[] | null = uvs ? [] : null
    const indexRemap = new Map<number, number>()

    let mergedCount = 0

    for (let i = 0; i < positions.length; i += 3) {
      const key = `${Math.round(positions[i] / tolerance) * tolerance},${Math.round(positions[i + 1] / tolerance) * tolerance},${Math.round(positions[i + 2] / tolerance) * tolerance}`

      if (!vertexMap.has(key)) {
        const newIndex = newPositions.length / 3
        vertexMap.set(key, newIndex)

        newPositions.push(positions[i], positions[i + 1], positions[i + 2])
        if (newNormals && normals) {
          newNormals.push(normals[i], normals[i + 1], normals[i + 2])
        }
        if (newUvs && uvs) {
          const uvIndex = (i / 3) * 2
          if (uvIndex + 1 < uvs.length) {
            newUvs.push(uvs[uvIndex], uvs[uvIndex + 1])
          }
        }
      } else {
        mergedCount++
      }

      indexRemap.set(i / 3, vertexMap.get(key)!)
    }

    const newIndices = indices
      ? Array.from(indices).map((i) => indexRemap.get(i)!)
      : null
    this.updateMeshGeometry(mesh, newPositions, newNormals, newUvs, newIndices)

    return mergedCount
  }

  public removeLooseVertices(object3D: THREE.Object3D): number {
    this.extractMeshes(object3D)
    let totalRemoved = 0

    console.log(`Removing loose vertices for ${this.meshes.length} meshes...`)

    this.meshes.forEach((meshData: MeshData) => {
      const removed = this.removeLooseVerticesForMesh(meshData.mesh)
      totalRemoved += removed
      console.log(`${meshData.name}: removed ${removed} loose vertices`)
    })

    console.log(
      `Total loose vertices removed across all meshes: ${totalRemoved}`,
    )
    return totalRemoved
  }

  private removeLooseVerticesForMesh(mesh: THREE.Mesh): number {
    const geometry = mesh.geometry as THREE.BufferGeometry
    const indices = geometry.index?.array as Uint16Array | Uint32Array | null

    if (!indices) {
      console.log("Cannot remove loose vertices from non-indexed geometry")
      return 0
    }

    const usedVertices = new Set<number>()
    for (let i = 0; i < indices.length; i++) {
      usedVertices.add(indices[i])
    }

    const positionAttribute = geometry.attributes
      .position as THREE.BufferAttribute
    const positions = positionAttribute.array as Float32Array
    const normalAttribute = geometry.attributes.normal as
      | THREE.BufferAttribute
      | undefined
    const normals = normalAttribute?.array as Float32Array | null
    const uvAttribute = geometry.attributes.uv as
      | THREE.BufferAttribute
      | undefined
    const uvs = uvAttribute?.array as Float32Array | null

    const newPositions: number[] = []
    const newNormals: number[] | null = normals ? [] : null
    const newUvs: number[] | null = uvs ? [] : null
    const indexRemap = new Map<number, number>()

    let removedCount = 0
    let newIndex = 0

    for (let i = 0; i < positions.length / 3; i++) {
      if (usedVertices.has(i)) {
        indexRemap.set(i, newIndex)
        newPositions.push(
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
        )
        if (newNormals && normals) {
          newNormals.push(
            normals[i * 3],
            normals[i * 3 + 1],
            normals[i * 3 + 2],
          )
        }
        if (newUvs && uvs && i * 2 + 1 < uvs.length) {
          newUvs.push(uvs[i * 2], uvs[i * 2 + 1])
        }
        newIndex++
      } else {
        removedCount++
      }
    }

    const newIndices = Array.from(indices).map(
      (index) => indexRemap.get(index)!,
    )
    this.updateMeshGeometry(mesh, newPositions, newNormals, newUvs, newIndices)

    return removedCount
  }

  public fixNonManifoldEdges(object3D: THREE.Object3D): number {
    this.extractMeshes(object3D)
    let totalFixed = 0

    console.log(`Fixing non-manifold edges for ${this.meshes.length} meshes...`)

    this.meshes.forEach((meshData: MeshData) => {
      const fixed = this.fixNonManifoldEdgesForMesh(meshData.mesh)
      totalFixed += fixed
      console.log(`${meshData.name}: fixed ${fixed} non-manifold edges`)
    })

    console.log(
      `Total non-manifold edges fixed across all meshes: ${totalFixed}`,
    )
    return totalFixed
  }

  private fixNonManifoldEdgesForMesh(mesh: THREE.Mesh): number {
    const geometry = mesh.geometry as THREE.BufferGeometry
    const indices = geometry.index?.array as Uint16Array | Uint32Array | null

    if (!indices) {
      console.log("Cannot fix non-manifold edges on non-indexed geometry")
      return 0
    }

    const edges = new Map<string, number[]>()
    const facesToRemove = new Set<number>()

    for (let i = 0; i < indices.length; i += 3) {
      const face = [indices[i], indices[i + 1], indices[i + 2]]

      for (let j = 0; j < 3; j++) {
        const v1 = face[j]
        const v2 = face[(j + 1) % 3]
        const edgeKey = v1 < v2 ? `${v1}-${v2}` : `${v2}-${v1}`

        if (!edges.has(edgeKey)) {
          edges.set(edgeKey, [])
        }
        edges.get(edgeKey)!.push(Math.floor(i / 3))
      }
    }

    for (const [_, faceList] of edges) {
      if (faceList.length > 2) {
        for (let i = 2; i < faceList.length; i++) {
          facesToRemove.add(faceList[i])
        }
      }
    }

    const newIndices: number[] = []
    for (let i = 0; i < indices.length; i += 3) {
      const faceIndex = Math.floor(i / 3)
      if (!facesToRemove.has(faceIndex)) {
        newIndices.push(indices[i], indices[i + 1], indices[i + 2])
      }
    }

    geometry.setIndex(newIndices)

    return facesToRemove.size
  }

  private removeDegenerateFacesForMesh(mesh: THREE.Mesh): number {
    const geometry = mesh.geometry as THREE.BufferGeometry
    const indices = geometry.index?.array as Uint16Array | Uint32Array | null

    if (!indices) {
      console.log("Cannot remove degenerate faces from non-indexed geometry")
      return 0
    }

    const positions = geometry.attributes.position.array as Float32Array
    const newIndices: number[] = []
    let removed = 0
    const tolerance = 0.000001

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i],
        b = indices[i + 1],
        c = indices[i + 2]

      // Skip faces where any two indices are the same
      if (a === b || b === c || c === a) {
        removed++
        continue
      }

      // Check for zero-area faces (collinear vertices)
      const v1 = new THREE.Vector3(
        positions[a * 3],
        positions[a * 3 + 1],
        positions[a * 3 + 2],
      )
      const v2 = new THREE.Vector3(
        positions[b * 3],
        positions[b * 3 + 1],
        positions[b * 3 + 2],
      )
      const v3 = new THREE.Vector3(
        positions[c * 3],
        positions[c * 3 + 1],
        positions[c * 3 + 2],
      )

      const edge1 = v2.clone().sub(v1)
      const edge2 = v3.clone().sub(v1)
      const cross = edge1.cross(edge2)

      if (cross.length() < tolerance) {
        removed++
        continue
      }

      newIndices.push(a, b, c)
    }

    geometry.setIndex(newIndices)
    return removed
  }

  public removeDegenerateFaces(object3D: THREE.Object3D): number {
    this.extractMeshes(object3D)
    let totalRemoved = 0

    console.log(`Removing degenerate faces for ${this.meshes.length} meshes...`)

    this.meshes.forEach((meshData) => {
      const removed = this.removeDegenerateFacesForMesh(meshData.mesh)
      totalRemoved += removed
      if (removed > 0) {
        console.log(`${meshData.name}: removed ${removed} degenerate faces`)
      }
    })

    console.log(`Total degenerate faces removed: ${totalRemoved}`)
    return totalRemoved
  }

  public recalculateNormals(object3D: THREE.Object3D): number {
    this.extractMeshes(object3D)

    console.log(`Recalculating normals for ${this.meshes.length} meshes...`)

    this.meshes.forEach((meshData: MeshData) => {
      meshData.mesh.geometry.computeVertexNormals()
      console.log(`${meshData.name}: normals recalculated`)
    })

    console.log("Normals recalculated for all meshes")
    return this.meshes.length
  }

  public async repairGeometry(
    object3D: THREE.Object3D,
    options: RepairOptions = {},
  ): Promise<RepairResults> {
    const {
      mergeTolerance = 0.000001,
      onProgress = null,
      skipOperations = [],
      ensureManifold = false,
    } = options

    console.log("Starting complete geometry repair process...")

    this.extractMeshes(object3D)

    let operations: RepairOperation[] = [
      {
        name: "mergeVertices",
        fn: () => this.mergeVertices(object3D, mergeTolerance),
      },
      {
        name: "removeLooseVertices",
        fn: () => this.removeLooseVertices(object3D),
      },
      {
        name: "fixNonManifoldEdges",
        fn: () => this.fixNonManifoldEdges(object3D),
      },
      {
        name: "removeDegenerateFaces",
        fn: () => this.removeDegenerateFaces(object3D),
      },
      {
        name: "recalculateNormals",
        fn: () => this.recalculateNormals(object3D),
      },
    ]

    if (ensureManifold) {
      operations = [
        ...operations,
        {
          name: "validateAndReRepair",
          fn: () => this.performIterativeRepair(object3D, mergeTolerance),
        },
      ]
    }

    const results: Record<string, number> = {}

    for (let i = 0; i < operations.length; i++) {
      const operation = operations[i]

      if (skipOperations.includes(operation.name)) {
        console.log(`Skipping ${operation.name}`)
        continue
      }

      console.log(`Running ${operation.name}...`)
      const result = await operation.fn()
      results[operation.name] = typeof result === "number" ? result : 0

      if (onProgress) {
        onProgress(((i + 1) / operations.length) * 100, operation.name)
      }
    }

    console.log("Complete geometry repair finished!")

    const finalAnalysis = this.analyzeGeometry(object3D)

    return {
      repairs: results,
      finalAnalysis,
    }
  }

  private performIterativeRepair(
    object3D: THREE.Object3D,
    tolerance: number,
  ): number {
    let totalIterations = 0
    const maxIterations = 3

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const analysis = this.analyzeGeometry(object3D)
      const hasIssues =
        analysis.totalStats.nonManifoldEdges > 0 ||
        analysis.totalStats.nonManifoldVertices > 0 ||
        analysis.totalStats.degenerateFaces > 0

      if (!hasIssues) {
        console.log(`Geometry is manifold after ${iteration} iterations`)
        break
      }

      console.log(`Iteration ${iteration + 1}: fixing remaining issues...`)
      this.removeDegenerateFaces(object3D)
      this.mergeVertices(object3D, tolerance)
      this.fixNonManifoldEdges(object3D)
      totalIterations++
    }

    return totalIterations
  }

  private updateMeshGeometry(
    mesh: THREE.Mesh,
    positions: number[],
    normals: number[] | null,
    uvs: number[] | null,
    indices: number[] | null,
  ): void {
    const newGeometry = new THREE.BufferGeometry()

    newGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    )

    if (normals && normals.length > 0) {
      newGeometry.setAttribute(
        "normal",
        new THREE.Float32BufferAttribute(normals, 3),
      )
    }

    if (uvs && uvs.length > 0) {
      newGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
    }

    if (indices && indices.length > 0) {
      newGeometry.setIndex(indices)
    }

    mesh.geometry.dispose()
    mesh.geometry = newGeometry
  }

  public removeMeshesWithIssues(
    object3D: THREE.Object3D,
    options: {
      maxDuplicateVertices?: number
      maxLooseVertices?: number
      maxNonManifoldEdges?: number
      maxNonManifoldVertices?: number
      maxDegenerateFaces?: number
    } = {},
  ): number {
    const {
      maxDuplicateVertices = 0,
      maxLooseVertices = 0,
      maxNonManifoldEdges = 0,
      maxNonManifoldVertices = 0,
      maxDegenerateFaces = 0,
    } = options

    // Analyze first
    this.analyzeGeometry(object3D)
    let removedCount = 0

    this.analysisResults.forEach((result, index) => {
      const hasTooManyIssues =
        (result.duplicateVertices || 0) > maxDuplicateVertices ||
        (result.looseVertices || 0) > maxLooseVertices ||
        (result.nonManifoldEdges || 0) > maxNonManifoldEdges ||
        (result.nonManifoldVertices || 0) > maxNonManifoldVertices ||
        (result.degenerateFaces || 0) > maxDegenerateFaces

      if (hasTooManyIssues) {
        const mesh = this.meshes[index].mesh
        const parent = mesh.parent
        object3D.remove(mesh)
        mesh.geometry.dispose()
        removedCount++
        console.log(
          `Removed mesh "${result.meshName}" (Index: ${result.meshIndex}) due to excessive issues.`,
        )

        // Clean up empty parent objects
        this.removeEmptyParents(parent)
      }
    })

    console.log(`Removed ${removedCount} mesh(es) with excessive issues.`)
    return removedCount
  }

  private removeEmptyParents(object: THREE.Object3D | null): void {
    if (!object || !(object instanceof THREE.Object3D)) return
    if (object.children.length === 0 && object.parent) {
      const parent = object.parent
      parent.remove(object)
      console.log(`Removed empty parent object: ${object.name || "(unnamed)"}`)
      this.removeEmptyParents(parent) // keep climbing up
    }
  }

  public getAnalysisResults(): readonly GeometryAnalysis[] {
    return Object.freeze([...this.analysisResults])
  }

  public resetToOriginal(): void {
    this.meshes.forEach((meshData: MeshData) => {
      meshData.mesh.geometry.dispose()
      meshData.mesh.geometry = meshData.originalGeometry.clone()
    })
    console.log("Reset all meshes to original geometries")
  }
}
