import * as THREE from "three"
import { acceleratedRaycast, MeshBVH } from "three-mesh-bvh"

// Patch Mesh raycast for BVH acceleration
THREE.Mesh.prototype.raycast = acceleratedRaycast

interface Options {
  maxEdgeLength?: number
  edgeThreshold?: number
  lineColor?: string
  lineWidth?: number
  depthTestSamples?: number
  depthBias?: number
  width: number
  height: number
  fullWidth?: number
  fullHeight?: number
  offsetX?: number
  offsetY?: number
}

export async function generateVisibleEdgesSVG(
  sceneRoot: THREE.Object3D,
  camera: THREE.Camera,
  options: Options,
): Promise<string> {
  const {
    maxEdgeLength = 1,
    edgeThreshold = 0.1,
    lineColor = "#000000",
    lineWidth = 1,
    depthTestSamples = 1,
    depthBias = 0,
    width,
    height,
    fullWidth = width,
    fullHeight = height,
    offsetX = 0,
    offsetY = 0,
  } = options

  const meshes: THREE.Mesh[] = []
  sceneRoot.traverse((child) => {
    if ((child as any).isMesh && child.visible) {
      const mesh = child as THREE.Mesh
      if (mesh?.geometry?.attributes.position) {
        // Ensure BVH is built for each mesh
        if (!(mesh.geometry as any).boundsTree) {
          ;(mesh.geometry as any).boundsTree = new MeshBVH(
            mesh.geometry as THREE.BufferGeometry,
          )
        }
        meshes.push(mesh)
      }
    }
  })

  if (!meshes.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`
  }

  const svgPaths: string[] = []
  const raycaster = new THREE.Raycaster()

  // Project 3D point to screen coordinates
  const projectToScreen = (point: THREE.Vector3) => {
    const projected = point.clone().project(camera)
    const fullX = (projected.x * 0.5 + 0.5) * fullWidth
    const fullY = (1 - (projected.y * 0.5 + 0.5)) * fullHeight

    return {
      x: fullX - offsetX,
      y: fullY - offsetY,
      z: projected.z,
      inFrustum:
        projected.z >= -1 &&
        projected.z <= 1 &&
        Math.abs(projected.x) <= 1 &&
        Math.abs(projected.y) <= 1,
    }
  }

  // Efficient occlusion test using raycaster
  const isEdgeVisible = (
    worldA: THREE.Vector3,
    worldB: THREE.Vector3,
    sourceMesh: THREE.Mesh,
  ): boolean => {
    const cameraPos = camera.position.clone()

    // Test multiple points along the edge, including endpoints
    let visibleSamples = 0
    const testPoints = Math.max(depthTestSamples, 2) // Always test at least endpoints

    for (let i = 0; i < testPoints; i++) {
      const t = testPoints === 1 ? 0.5 : i / (testPoints - 1)
      const testPoint = worldA.clone().lerp(worldB, t)

      // Move test point slightly towards camera to avoid self-intersection
      const direction = testPoint.clone().sub(cameraPos).normalize()
      const distance = cameraPos.distanceTo(testPoint)
      const adjustedTestPoint = testPoint
        .clone()
        .sub(direction.clone().multiplyScalar(depthBias * 2))
      const adjustedDistance = cameraPos.distanceTo(adjustedTestPoint)

      raycaster.set(cameraPos, direction)
      raycaster.far = adjustedDistance - depthBias

      // Get all intersections
      const intersections = raycaster.intersectObjects(meshes, false)

      // Check if any intersection occludes this point
      let isOccluded = false
      for (const intersection of intersections) {
        // More robust self-intersection filtering
        if (intersection.object === sourceMesh) {
          const distDiff = Math.abs(intersection.distance - distance)
          // Use adaptive threshold based on edge length
          const edgeLength = worldA.distanceTo(worldB)
          const adaptiveThreshold = Math.max(depthBias * 20, edgeLength * 0.01)
          if (distDiff < adaptiveThreshold) continue
        }

        // If intersection is closer than our adjusted test point, it's occluded
        if (intersection.distance < adjustedDistance - depthBias) {
          isOccluded = true
          break
        }
      }

      if (!isOccluded) visibleSamples++
    }

    // Edge is visible if any samples are visible (more permissive for thin edges)
    return visibleSamples > 0
  }

  // Process each mesh
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false)
    const geometry = mesh.geometry as THREE.BufferGeometry
    const worldMatrix = mesh.matrixWorld

    // Generate edges
    const edgesGeometry = new THREE.EdgesGeometry(geometry, edgeThreshold)
    const edgePositions = edgesGeometry.attributes.position
      .array as Float32Array

    // Process each edge
    for (let i = 0; i < edgePositions.length; i += 6) {
      // Get edge vertices in local space
      const localA = new THREE.Vector3(
        edgePositions[i],
        edgePositions[i + 1],
        edgePositions[i + 2],
      )
      const localB = new THREE.Vector3(
        edgePositions[i + 3],
        edgePositions[i + 4],
        edgePositions[i + 5],
      )

      // Transform to world space
      const worldA = localA.clone().applyMatrix4(worldMatrix)
      const worldB = localB.clone().applyMatrix4(worldMatrix)

      const edgeLength = worldA.distanceTo(worldB)
      if (edgeLength === 0 || edgeLength > maxEdgeLength) continue

      // Project endpoints to screen
      const screenA = projectToScreen(worldA)
      const screenB = projectToScreen(worldB)

      // Skip if either endpoint is outside frustum
      if (!screenA.inFrustum || !screenB.inFrustum) continue

      // Skip if too short on screen (sub-pixel) - more permissive threshold
      const screenDistance = Math.sqrt(
        (screenB.x - screenA.x) ** 2 + (screenB.y - screenA.y) ** 2,
      )
      if (screenDistance < 0.25) continue

      // Perform occlusion test
      if (!isEdgeVisible(worldA, worldB, mesh)) continue

      // Create SVG path for this edge
      svgPaths.push(
        `M ${screenA.x.toFixed(1)} ${screenA.y.toFixed(1)} L ${screenB.x.toFixed(1)} ${screenB.y.toFixed(1)}`,
      )
    }

    edgesGeometry.dispose()
  }

  // Generate SVG
  const header = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`

  const pathsString =
    svgPaths.length > 0
      ? `<g fill="none" stroke="${lineColor}" stroke-width="${lineWidth}" stroke-linecap="round">
  ${svgPaths.map((d) => `<path d="${d}"/>`).join("\n  ")}
</g>`
      : ""

  return `${header}
${pathsString}
</svg>`
}
