<script lang="ts">
import { GUI } from "lil-gui"
import { onMount } from "svelte"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { SobelOperatorShader } from "three/addons/shaders/SobelOperatorShader.js"
import { WebGLPathTracer } from "three-gpu-pathtracer"
import { ParallelMeshBVHWorker } from "three-mesh-bvh/src/workers/ParallelMeshBVHWorker.js"
import {
  FillPass,
  SVGMesh,
  SVGRenderer,
  VisibleChainPass,
} from "three-svg-renderer"
import { type GizmoOptions, ViewportGizmo } from "three-viewport-gizmo"
import ProgressBar from "./components/progress_bar.svelte"
import Spinner from "./components/spinner.svelte"
import { generateVisibleEdgesSVG } from "./lib/generate_svg"
import { GeometryRepairer } from "./lib/geometry_fix"

let container: HTMLDivElement | null = null
let progress = $state(0)
let loadingProgress = $state(false)
let loadingSpinner = $state(false)
let resolutionScale = $state(1)

let renderer: THREE.WebGLRenderer
let pathTracer: WebGLPathTracer
let composer: EffectComposer
let sobelPass: ShaderPass
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
let controls: OrbitControls
let gizmo: ViewportGizmo
let loader: GLTFLoader
let currentModel: THREE.Object3D | null = null

let globalLight: THREE.RectAreaLight
let spotLight: THREE.SpotLight
let spotLightHelper: THREE.SpotLightHelper
let grid: THREE.GridHelper
let globalSurface: THREE.Mesh
let globalSurfaceMaterial: THREE.MeshStandardMaterial
let gui: GUI | null = null

let boundingBoxHelper: THREE.BoxHelper | null = null
let dimensionLabels: THREE.Sprite[] = []
const bboxParams = { showBoundingBox: false }

const backgroundColor = "#222222"

const sceneParams = {
  backgroundColor: "#222222",
  globalLight: 2.0,
  showGrid: true,
  gridSize: 10,
  showSurface: true,
  surfaceRoughness: 1.0,
  surfaceMetalness: 0.0,
}

const spotLightParams = {
  showHelper: false,
  intensity: 500,
  distance: 10,
  azimuth: 45,
  polar: 45,
}

const viewParams = {
  renderMode: "Raster",
  camera: "Perspective",
  texturesEnabled: true,
  xray: false,
  lineMode: false,
  shadows: true,
}

function makeTextSprite(message: string): THREE.Sprite {
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Failed to get canvas context")

  const fontSize = 20
  const scaleFactor = 4
  const pixelRatio = (window.devicePixelRatio || 1) * scaleFactor

  context.font = `${fontSize}px Arial`
  const metrics = context.measureText(message)
  const textWidth = metrics.width

  const padding = 8
  const width = textWidth + padding * 2
  const height = fontSize + padding * 2

  canvas.width = width * pixelRatio
  canvas.height = height * pixelRatio
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`

  context.scale(pixelRatio, pixelRatio)

  context.fillStyle = "white"
  context.strokeStyle = "black"
  context.lineWidth = 1
  context.textAlign = "center"
  context.textBaseline = "middle"

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = "high"

  const centerX = width / 2
  const centerY = height / 2

  context.strokeText(message, centerX, centerY)
  context.fillText(message, centerX, centerY)

  const texture = new THREE.CanvasTexture(canvas)
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter

  const material = new THREE.SpriteMaterial({ map: texture, transparent: true })
  const sprite = new THREE.Sprite(material)

  const aspect = canvas.width / canvas.height
  const baseScale = 0.1
  sprite.scale.set(baseScale * aspect, baseScale, 1)
  return sprite
}

function addBoundingBoxAndLabels(object: THREE.Object3D) {
  if (boundingBoxHelper) scene.remove(boundingBoxHelper)
  dimensionLabels.forEach((l) => {
    scene.remove(l)
  })
  dimensionLabels = []

  const box = new THREE.Box3().setFromObject(object)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  boundingBoxHelper = new THREE.BoxHelper(object, 0xff0000)
  boundingBoxHelper.visible = bboxParams.showBoundingBox
  scene.add(boundingBoxHelper)

  const wLabel = makeTextSprite(`W: ${size.x.toFixed(2)}`)
  const hLabel = makeTextSprite(`H: ${size.y.toFixed(2)}`)
  const lLabel = makeTextSprite(`L: ${size.z.toFixed(2)}`)

  dimensionLabels.push(wLabel, hLabel, lLabel)
  dimensionLabels.forEach((l) => {
    l.visible = bboxParams.showBoundingBox
    scene.add(l)
  })

  object.userData.bbox = { wLabel, hLabel, lLabel }
}

function disposeModel(obj: THREE.Object3D | null) {
  if (!obj) return
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose()
      if (child.material) {
        const mat = child.material
        if (Array.isArray(mat))
          mat.forEach((m) => {
            m.dispose()
          })
        else mat.dispose()
      }
    }
  })
}

async function loadModelFromFile(file: File) {
  if (!loader) return
  if (currentModel) {
    scene.remove(currentModel)
    disposeModel(currentModel)
    currentModel = null
  }

  const reader = new FileReader()
  reader.onload = (e) => {
    if (!e.target?.result) return
    const arrayBuffer = e.target.result as ArrayBuffer
    loader.parse(
      arrayBuffer,
      "",
      async (gltf) => {
        currentModel = gltf.scene || gltf.scenes?.[0] || null
        if (!currentModel) return

        processMaterials(currentModel)
        await normalizeAndAddModel(currentModel)
        updateMaterials()
        focusOnObject(currentModel)
        addBoundingBoxAndLabels(currentModel)
      },
      (error) => {
        console.error("Error parsing GLB from file:", error)
      },
    )
  }
  reader.readAsArrayBuffer(file)
}

function setModelShadows(model: THREE.Object3D, enabled: boolean) {
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = enabled
      child.receiveShadow = enabled
    }
  })
}

function processMaterials(object: THREE.Object3D) {
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy()
  const allMeshes: THREE.Mesh[] = []

  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      allMeshes.push(child)
    }
  })

  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return

    child.userData.isInterior = isInteriorMesh(child, allMeshes)

    child.castShadow = true
    child.receiveShadow = true

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material]

    materials.forEach((material: THREE.Material) => {
      if (!(material instanceof THREE.MeshStandardMaterial)) {
        return
      }

      if (material.map) {
        material.depthWrite = true
        material.depthTest = true

        material.userData.original = {
          map: material.map,
          transparent: material.transparent,
          opacity: material.opacity,
          depthWrite: material.depthWrite,
          depthTest: material.depthTest,
        }
      }

      if (renderer.capabilities.isWebGL2) {
        material.alphaToCoverage = true
      }

      ;[
        material.map,
        material.normalMap,
        material.roughnessMap,
        material.metalnessMap,
        material.aoMap,
      ].forEach((tex) => {
        if (tex) {
          tex.anisotropy = maxAnisotropy
          tex.minFilter = THREE.LinearMipmapLinearFilter
          tex.magFilter = THREE.LinearFilter
        }
      })

      material.needsUpdate = true
    })
  })
}

function isInteriorMesh(
  targetMesh: THREE.Mesh,
  allMeshes: THREE.Mesh[],
): boolean {
  const targetBox = new THREE.Box3().setFromObject(targetMesh)
  const targetCenter = targetBox.getCenter(new THREE.Vector3())

  for (const mesh of allMeshes) {
    if (mesh === targetMesh) continue

    const meshBox = new THREE.Box3().setFromObject(mesh)

    if (meshBox.containsBox(targetBox)) {
      return true
    }

    if (isPointInsideMesh(targetCenter, mesh)) {
      return true
    }
  }

  return false
}

function isPointInsideMesh(point: THREE.Vector3, mesh: THREE.Mesh): boolean {
  const raycaster = new THREE.Raycaster()
  const direction = new THREE.Vector3(1, 0, 0)
  raycaster.set(point, direction)
  const intersects = raycaster.intersectObject(mesh, false)

  return intersects.length % 2 === 1
}

function focusOnObject(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object)
  const center = new THREE.Vector3()
  box.getCenter(center)
  const size = new THREE.Vector3()
  box.getSize(size)

  controls.target.copy(center)

  const maxDim = Math.max(size.x, size.y, size.z)

  if (camera instanceof THREE.PerspectiveCamera) {
    // Perspective camera - calculate distance based on FOV
    const fov = camera.fov * (Math.PI / 180)
    let cameraZ = Math.abs(maxDim / Math.tan(fov / 2))
    cameraZ *= 1.5 // add a margin

    camera.position.set(
      center.x + cameraZ,
      center.y + cameraZ,
      center.z + cameraZ,
    )
  } else if (camera instanceof THREE.OrthographicCamera) {
    // Orthographic camera - adjust zoom instead of distance
    const margin = 1.5
    const requiredZoom = Math.min(
      (camera.right - camera.left) / (size.x * margin),
      (camera.top - camera.bottom) / (size.y * margin),
    )

    camera.zoom = Math.max(requiredZoom, 0.1) // prevent zero/negative zoom
    camera.updateProjectionMatrix()

    // Still move the camera position for better 3D perspective
    const distance = maxDim * 2 // arbitrary distance for good 3D view
    camera.position.set(
      center.x + distance,
      center.y + distance,
      center.z + distance,
    )
  }

  camera.lookAt(center)
  controls.update()
}

async function normalizeAndAddModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  if (maxDim > 0) model.scale.setScalar(1.0 / maxDim)
  scene.add(model)

  await setPathTracerScene()
}

async function setPathTracerScene() {
  loadingProgress = true
  progress = 0
  await pathTracer.setSceneAsync(scene, camera, {
    onProgress: (v: number) => {
      progress = v * 100
    },
  })

  progress = 100
  setTimeout(() => {
    loadingProgress = false
    progress = 0
  }, 500)
}

function updateMaterials() {
  if (!currentModel) return
  currentModel.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material]

    materials.forEach((material: THREE.Material) => {
      if (
        !(material instanceof THREE.MeshStandardMaterial) ||
        !("map" in material) ||
        !("original" in material.userData)
      )
        return

      if (!material.userData.original) {
        console.log(material.map)
      }
      material.map = viewParams.texturesEnabled
        ? material.userData.original.map || null
        : null
      material.needsUpdate = true
    })
  })
  pathTracer.updateMaterials()
}

function updateLabelPositions() {
  if (!currentModel || !currentModel.userData.bbox) return
  const { wLabel, hLabel, lLabel } = currentModel.userData.bbox

  const updatedBox = new THREE.Box3().setFromObject(currentModel)
  const size = updatedBox.getSize(new THREE.Vector3())
  const center = updatedBox.getCenter(new THREE.Vector3())

  const cameraPos = camera.position.clone()

  const nearestX =
    cameraPos.x > center.x ? center.x + size.x / 2 : center.x - size.x / 2
  const nearestY =
    cameraPos.y > center.y ? center.y + size.y / 2 : center.y - size.y / 2
  const nearestZ =
    cameraPos.z > center.z ? center.z + size.z / 2 : center.z - size.z / 2

  const offset = size.length() * 0.05

  const lengthOffset = cameraPos.z > center.z ? offset : -offset
  wLabel.position.set(center.x, center.y, nearestZ + lengthOffset)

  const heightOffset = cameraPos.y > center.y ? offset : -offset
  hLabel.position.set(center.x, nearestY + heightOffset, center.z)

  const widthOffset = cameraPos.x > center.x ? offset : -offset
  lLabel.position.set(nearestX + widthOffset, center.y, center.z)

  dimensionLabels.forEach((label) => {
    label.quaternion.copy(camera.quaternion)
  })
}

function updateGlobalSurfaceAndLight() {
  if (!camera) return

  if (globalLight) {
    globalLight.position.x = Math.floor(camera.position.x / 10) * 10
    globalLight.position.z = Math.floor(camera.position.z / 10) * 10
  }

  if (globalSurface) {
    globalSurface.position.x = Math.floor(camera.position.x / 10) * 10
    globalSurface.position.z = Math.floor(camera.position.z / 10) * 10

    // Optional: Update texture offset for seamless movement
    if (globalSurfaceMaterial.map) {
      const offsetX = (camera.position.x % 10) / 10
      const offsetZ = (camera.position.z % 10) / 10
      globalSurfaceMaterial.map.offset.set(offsetX, offsetZ)
    }
  }
}

function toggleXray(enabled: boolean) {
  if (!currentModel) return

  //const internalKeywords = ["root", "roll", "bone"] // /x_root_\d+_0/

  currentModel.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return

    if (child instanceof THREE.Mesh && child.material) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]

      const isInternal = child.userData.isInterior as boolean
      //const isInternal = internalKeywords.some((keyword) =>
      //  child.name.toLowerCase().includes(keyword),
      //)
      //const isInternal = child.name.toLowerCase().match(internalPattern) !== null

      materials.forEach((material: THREE.Material) => {
        if (!isInternal) return

        if (enabled) {
          child.renderOrder = 2
          material.depthTest = false
          material.depthWrite = false
          material.transparent = true
          material.opacity = 0.8
        } else {
          const original = material.userData.original
          if (original) {
            material.transparent = original.transparent
            material.opacity = original.opacity
            material.depthTest = original.depthTest
            material.depthWrite = original.depthWrite
          }
          child.renderOrder = 0
        }
        material.needsUpdate = true
      })
    }
  })
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  await loadModelFromFile(input.files[0])
}

function setupComposer(width: number, height: number, pixelRatio: number) {
  if (!container) return

  composer = new EffectComposer(renderer)
  composer.setPixelRatio(pixelRatio)
  composer.setSize(width, height)

  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)

  sobelPass = new ShaderPass(SobelOperatorShader)
  sobelPass.uniforms.resolution.value.x = width * pixelRatio
  sobelPass.uniforms.resolution.value.y = height * pixelRatio
  sobelPass.enabled = false
  composer.addPass(sobelPass)
}

function downloadImage(dataURL: string, filename: string = "image.png") {
  const link = document.createElement("a")
  link.href = dataURL
  link.download = filename
  link.click()
}
// missing function in three.js
;(THREE.Triangle as any).getUV = (
  point: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  uv1: THREE.Vector2,
  uv2: THREE.Vector2,
  uv3: THREE.Vector2,
  target: THREE.Vector2,
) => {
  const barycoord = new THREE.Vector3()
  THREE.Triangle.getBarycoord(point, p1, p2, p3, barycoord)

  target.set(
    uv1.x * barycoord.x + uv2.x * barycoord.y + uv3.x * barycoord.z,
    uv1.y * barycoord.x + uv2.y * barycoord.y + uv3.y * barycoord.z,
  )
  return target
}

async function exportSceneToPng(resolutionScale: number | null) {
  if (!container || !currentModel || !resolutionScale) return

  gizmo.visible = false

  if (viewParams.renderMode === "Path Tracer") {
    pathTracer.renderSample()
    const dataURL = renderer.domElement.toDataURL("image/png", 1.0)
    downloadImage(dataURL, "scene.png")
    gizmo.visible = false
    return
  }

  const needsUpdate = resolutionScale !== 1

  const originalWidth = renderer.domElement.width
  const originalHeight = renderer.domElement.height
  const clientWidth = container.clientWidth
  const clientHeight = container.clientHeight

  if (needsUpdate) {
    const exportWidth = clientWidth * resolutionScale
    const exportHeight = clientHeight * resolutionScale

    renderer.setSize(exportWidth, exportHeight, false)
    composer.setSize(exportWidth, exportHeight)
  }

  composer.render()
  const dataURL = renderer.domElement.toDataURL("image/png", 1.0)
  downloadImage(dataURL, "scene.png")

  if (needsUpdate) {
    renderer.setSize(originalWidth, originalHeight, false)
    composer.setSize(originalWidth, originalHeight)
  }

  gizmo.visible = true
}

interface ViewBox {
  minX: number
  minY: number
  width: number
  height: number
}

function boundingSvgSize(
  container: HTMLElement,
  camera: THREE.Camera,
  model: THREE.Object3D,
): ViewBox {
  const box = new THREE.Box3().setFromObject(model)

  // Project bounding box corners to screen space to find SVG dimensions
  const corners = [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ]

  // Project corners to screen coordinates
  const projectedCorners = corners.map((corner) => {
    const projected = corner.clone().project(camera)
    return {
      x: ((projected.x + 1) * container.clientWidth) / 2,
      y: ((-projected.y + 1) * container.clientHeight) / 2,
    }
  })

  // Find bounding rectangle in screen space
  const minX = Math.min(...projectedCorners.map((p) => p.x))
  const maxX = Math.max(...projectedCorners.map((p) => p.x))
  const minY = Math.min(...projectedCorners.map((p) => p.y))
  const maxY = Math.max(...projectedCorners.map((p) => p.y))

  const svgWidth = Math.ceil(maxX - minX)
  const svgHeight = Math.ceil(maxY - minY)

  return { minX: minX, minY: minY, width: svgWidth, height: svgHeight }
}

async function exportSceneToSvg() {
  if (!container || !currentModel) return

  gizmo.visible = false

  let svg = ""
  const viewBox = boundingSvgSize(container, camera, currentModel)

  try {
    const repairer = new GeometryRepairer()
    const modelCopy = currentModel.clone(true)
    const results = await repairer.repairGeometry(modelCopy, {
      mergeTolerance: 1e-5,
    })

    const totalIssues = results.finalAnalysis.totalStats.totalIssues
    if (totalIssues !== undefined && totalIssues > 0) {
      throw new Error(
        "Model has issues preventing SVG export using 'three-svg-renderer'",
      )
    }

    const svgMeshes: SVGMesh[] = []
    modelCopy.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        svgMeshes.push(new SVGMesh(child))
      }
    })

    const svgRenderer = new SVGRenderer()
    svgRenderer.addPass(new FillPass())
    svgRenderer.addPass(
      new VisibleChainPass({ defaultStyle: { color: "#000000", width: 1 } }),
    )

    const svgElement = await svgRenderer.generateSVG(svgMeshes, camera, {
      w: viewBox.width,
      h: viewBox.height,
    })
    svg = svgElement.svg()
  } catch (error) {
    console.warn("Reverting to fallback SVG renderer: ", error)

    svg = await generateVisibleEdgesSVG(scene, camera, {
      width: viewBox.width,
      height: viewBox.height,
      fullWidth: container.clientWidth,
      fullHeight: container.clientHeight,
      offsetX: viewBox.minX,
      offsetY: viewBox.minY,
      lineColor: "#000000",
      lineWidth: 1,
      edgeThreshold: 1,
      depthTestSamples: 2,
      depthBias: 1e-4,
    })
  }
  if (!svg) {
    throw new Error("Failed to generate SVG with both renderers")
  }

  const blob = new Blob([svg], {
    type: "image/svg+xml;charset=utf-8",
  })
  const dataUrl = URL.createObjectURL(blob)
  downloadImage(dataUrl, "scene.svg")

  gizmo.visible = true
}

onMount(() => {
  let rafId: number
  let resize: () => void

  async function init() {
    if (!container) return

    let width = container.clientWidth
    let height = container.clientHeight
    let aspect = width / height
    const pixelRatio = Math.min(window.devicePixelRatio, 2)

    // renderer
    renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(pixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    renderer.shadowMap.enabled = viewParams.shadows
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    container.appendChild(renderer.domElement)

    // scene
    scene = new THREE.Scene()
    scene.background = new THREE.Color(0x222222)

    // camera
    const perspectiveCamera = new THREE.PerspectiveCamera(
      50,
      aspect,
      0.01,
      1000,
    )

    const frustumSize = 5
    const orthographicCamera = new THREE.OrthographicCamera(
      (frustumSize * aspect) / -2,
      (frustumSize * aspect) / 2,
      frustumSize / 2,
      frustumSize / -2,
      0.01,
      1000,
    )
    orthographicCamera.zoom = 1
    orthographicCamera.updateProjectionMatrix()

    camera =
      viewParams.camera === "Perspective"
        ? perspectiveCamera
        : orthographicCamera

    camera.position.set(2, 2, 2)

    setupComposer(width, height, pixelRatio)

    // lights
    globalLight = new THREE.RectAreaLight(
      0xffffff,
      sceneParams.globalLight,
      1000,
      1000,
    )
    globalLight.position.set(0, 100, 0)
    globalLight.lookAt(0, 0, 0)
    scene.add(globalLight)

    spotLight = new THREE.SpotLight(0xffffff, spotLightParams.intensity)
    spotLight.position.setFromSpherical(
      new THREE.Spherical(
        spotLightParams.distance,
        THREE.MathUtils.degToRad(spotLightParams.polar),
        THREE.MathUtils.degToRad(spotLightParams.azimuth),
      ),
    )

    spotLight.castShadow = true
    spotLight.shadow.mapSize.set(2 ** 12, 2 ** 12)
    spotLight.shadow.camera.near = 0.5
    spotLight.shadow.camera.far = 100
    spotLight.shadow.camera.fov = 30
    spotLight.shadow.focus = 1.0
    spotLight.shadow.bias = 0.0001
    spotLight.shadow.normalBias = 0.05
    spotLight.shadow.radius = 10 // Softer shadow edges
    spotLight.shadow.blurSamples = 16 // Smoother shadow transitions
    scene.add(spotLight)

    //const shadowHelper = new THREE.CameraHelper(spotLight.shadow.camera)
    //scene.add(shadowHelper)
    spotLightHelper = new THREE.SpotLightHelper(spotLight, 0xffffff)
    scene.add(spotLightHelper)
    spotLightHelper.visible = spotLightParams.showHelper
    // grid
    grid = new THREE.GridHelper(10, 20, 0x444444, 0x111111)
    scene.add(grid)

    // ground plane
    const surfaceGeometry = new THREE.PlaneGeometry(1000, 1000)
    globalSurfaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 1.0,
      metalness: 0.0,
    })
    globalSurface = new THREE.Mesh(surfaceGeometry, globalSurfaceMaterial)
    globalSurface.rotation.x = -Math.PI / 2
    globalSurface.position.y = -0.01
    globalSurface.receiveShadow = true
    scene.add(globalSurface)

    // path tracer
    pathTracer = new WebGLPathTracer(renderer)
    pathTracer.setBVHWorker(new ParallelMeshBVHWorker())

    // controls
    controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.screenSpacePanning = false

    const gizmoOptions: GizmoOptions = {
      placement: "bottom-right",
    }
    gizmo = new ViewportGizmo(camera, renderer, gizmoOptions)
    gizmo.attachControls(controls)

    // loader
    loader = new GLTFLoader()

    // GUI for lights
    gui = new GUI()

    const sceneFolder = gui.addFolder("Scene")
    sceneFolder
      .add(sceneParams, "globalLight", 0.0, 5.0, 0.1)
      .name("Global Light")
      .onChange((value: number) => {
        globalLight.intensity = value
        pathTracer.updateLights()
      })

    sceneFolder
      .addColor(sceneParams, "backgroundColor")
      .name("Background color")
      .onChange((value: string) => {
        scene.background = new THREE.Color(value)
      })

    sceneFolder
      .add(
        {
          reset: () => {
            sceneParams.backgroundColor = backgroundColor
            scene.background = new THREE.Color(backgroundColor)
          },
        },
        "reset",
      )
      .name("Reset background")

    sceneFolder
      .add(sceneParams, "showGrid")
      .name("Show Grid")
      .onChange((value: boolean) => {
        grid.visible = value
      })

    sceneFolder
      .add(sceneParams, "gridSize", 10, 100, 10)
      .name("Grid Size")
      .onChange((value: number) => {
        scene.remove(grid)
        grid.dispose()
        grid = new THREE.GridHelper(value, value * 2, 0x444444, 0x111111)
        grid.position.y = -0.01
        grid.visible = sceneParams.showGrid
        scene.add(grid)
      })

    sceneFolder
      .add(sceneParams, "showSurface")
      .name("Show Surface")
      .onChange(async (value: boolean) => {
        globalSurface.visible = value
        await setPathTracerScene()
      })

    sceneFolder
      .add(sceneParams, "surfaceRoughness", 0.0, 1.0, 0.01)
      .name("Surface roughness")
      .onChange((value: number) => {
        globalSurfaceMaterial.roughness = value
        globalSurfaceMaterial.needsUpdate = true
        pathTracer.updateMaterials()
      })

    sceneFolder
      .add(sceneParams, "surfaceMetalness", 0.0, 1.0, 0.01)
      .name("Surface metalness")
      .onChange((value: number) => {
        globalSurfaceMaterial.metalness = value
        globalSurfaceMaterial.needsUpdate = true
        pathTracer.updateMaterials()
      })

    const spotLightFolder = gui.addFolder("Spot light")

    spotLightFolder
      .add(spotLightParams, "intensity", 0, 1000, 10)
      .name("Intensity")
      .onChange((value: number) => {
        spotLight.intensity = value
        pathTracer.updateLights()
      })

    spotLightFolder
      .add(spotLightParams, "distance", 0, 100, 1)
      .name("Distance")
      .onChange((value: number) => {
        const spherical = new THREE.Spherical(
          value,
          THREE.MathUtils.degToRad(spotLightParams.polar),
          THREE.MathUtils.degToRad(spotLightParams.azimuth),
        )
        spotLight.position.setFromSpherical(spherical)
        spotLightHelper.update()
        pathTracer.updateLights()
      })

    spotLightFolder
      .add(spotLightParams, "azimuth", 0, 360, 1)
      .name("Azimuthal angle")
      .onChange((value: number) => {
        const spherical = new THREE.Spherical(
          spotLightParams.distance,
          THREE.MathUtils.degToRad(spotLightParams.polar),
          THREE.MathUtils.degToRad(value),
        )
        spotLight.position.setFromSpherical(spherical)
        spotLightHelper.update()
        pathTracer.updateLights()
      })

    spotLightFolder
      .add(spotLightParams, "polar", 0, 180, 1)
      .name("Polar angle")
      .onChange((value: number) => {
        const spherical = new THREE.Spherical(
          spotLightParams.distance,
          THREE.MathUtils.degToRad(value),
          THREE.MathUtils.degToRad(spotLightParams.azimuth),
        )
        spotLight.position.setFromSpherical(spherical)
        spotLightHelper.update()
        pathTracer.updateLights()
      })

    spotLightFolder
      .add(spotLightParams, "showHelper")
      .name("Show Helper")
      .onChange((value: boolean) => {
        spotLightHelper.visible = value
      })

    const toolsFolder = gui.addFolder("Tools")
    const pathTracerControlListener = () => pathTracer.updateCamera()

    toolsFolder
      .add(viewParams, "renderMode", ["Raster", "Path Tracer"])
      .name("Render Mode")
      .onChange((mode: string) => {
        if (mode === "Raster") {
          controls.removeEventListener("change", pathTracerControlListener)
        } else if (mode === "Path Tracer") {
          pathTracer.reset()
          controls.addEventListener("change", pathTracerControlListener)
        }
      })

    toolsFolder
      .add(viewParams, "camera", ["Perspective", "Orthographic"])
      .name("Camera")
      .onChange(async (mode: string) => {
        if (!container) return

        const oldPosition = camera.position.clone()
        const oldTarget = controls.target.clone()

        camera = mode === "Perspective" ? perspectiveCamera : orthographicCamera

        camera.position.copy(oldPosition)
        camera.updateProjectionMatrix()

        controls.object = camera
        controls.target.copy(oldTarget)
        controls.update()

        gizmo.camera = camera
        gizmo.update()

        if (composer.passes.length > 0) {
          const renderPass = composer.passes[0] as RenderPass
          renderPass.camera = camera
        }

        if (pathTracer && viewParams.renderMode === "Path Tracer") {
          pathTracer.reset()
          await setPathTracerScene()
        }
      })

    toolsFolder
      .add(viewParams, "texturesEnabled")
      .name("Textures")
      .onChange(updateMaterials)

    toolsFolder
      .add(viewParams, "xray")
      .name("X-Ray View")
      .onChange((value: boolean) => {
        toggleXray(value)
      })
    toolsFolder
      .add(viewParams, "lineMode")
      .name("Line Mode")
      .onChange((value: boolean) => {
        if (sobelPass) sobelPass.enabled = value
      })
    toolsFolder
      .add(viewParams, "shadows")
      .name("Shadows")
      .onChange((value: boolean) => {
        renderer.shadowMap.enabled = value
        if (currentModel) setModelShadows(currentModel, value)
        globalSurface.receiveShadow = value
      })
    toolsFolder
      .add(bboxParams, "showBoundingBox")
      .name("Show Bounding Box")
      .onChange((value: boolean) => {
        if (boundingBoxHelper) boundingBoxHelper.visible = value
        dimensionLabels.forEach((l) => {
          l.visible = value
        })
      })

    resize = async () => {
      if (!container) return

      width = container.clientWidth
      height = container.clientHeight
      aspect = width / height

      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = aspect
      } else {
        orthographicCamera.left = (-frustumSize * aspect) / 2
        orthographicCamera.right = (frustumSize * aspect) / 2
        orthographicCamera.top = frustumSize / 2
        orthographicCamera.bottom = -frustumSize / 2
      }

      camera.updateProjectionMatrix()
      renderer.setSize(width, height)
      composer.setSize(width, height)
      if (pathTracer) {
        await setPathTracerScene()
      }
      if (sobelPass) {
        const pixelRatio = Math.min(window.devicePixelRatio, 2)
        sobelPass.uniforms.resolution.value.x = width * pixelRatio
        sobelPass.uniforms.resolution.value.y = height * pixelRatio
      }
      gizmo.update()
    }

    window.addEventListener("resize", resize)

    const animate = () => {
      controls.update()
      updateLabelPositions()
      updateGlobalSurfaceAndLight()
      if (viewParams.renderMode === "Raster" || viewParams.lineMode) {
        composer.render()
      } else if (viewParams.renderMode === "Path Tracer") {
        if (pathTracer.isCompiling) {
          composer.render()
          progress = pathTracer.samples
          loadingSpinner = true
        } else {
          loadingSpinner = false
          pathTracer.renderSample()
        }
      }
      gizmo.render()
      rafId = requestAnimationFrame(animate)
    }
    animate()
  }

  init()

  return () => {
    if (rafId) {
      cancelAnimationFrame(rafId)
    }
    if (resize) {
      window.removeEventListener("resize", resize)
    }
    if (gui) {
      gui.destroy()
      gui = null
    }
    if (pathTracer && typeof pathTracer.dispose === "function") {
      pathTracer.dispose()
    }

    if (renderer) {
      renderer.forceContextLoss()
      renderer.domElement?.remove()
      renderer.dispose()
    }
    if (composer) composer.dispose()
    if (currentModel) disposeModel(currentModel)
  }
})
</script>

<div class="container">
  <header class="header">
    <fieldset>
      <legend>Load Model</legend>
      <input type="file" accept=".glb" onchange={onFileChange} />
    </fieldset>
    <fieldset class="export">
      <legend>Export</legend>
      <div class="export-png">
        <input type="number" min="1" max="4" step="1" bind:value={resolutionScale} />
        <button onclick={() => exportSceneToPng(resolutionScale)}>PNG</button>
      </div>
      <button onclick={() => exportSceneToSvg()}>SVG</button>
    </fieldset>
  </header>
  <ProgressBar 
    value={progress}
    visible={loadingProgress}
    top="calc(100% - 0.5rem)"
    left="0"
    barWidth="100%"
    barHeight="0.5rem"
  />
  <Spinner 
    visible={loadingProgress}
    size="1rem"
    top="calc(100% - 2rem)"
    left="0.5rem"
  />

  <div bind:this={container} class="viewer"></div>
</div>

<style>
  :global(:root) {
    --color-bg: #111;
    --color-bg-container: #222;
    --color-text: #eee;
    --color-border: #555;
    --color-border-hover: #777;
    --color-bg-button: #333;
    --color-bg-button-hover: #444;
    --color-bg-button-active: #555;
    --border-radius: 4px;
    --padding-button: 0.4rem 0.8rem;
  }
  
  :global(body) {
    background: var(--color-bg);
    color: var(--color-text);
  }

  :global(fieldset) {
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: 0.2rem;
  }

  :global(legend) {
    font-size: 0.8rem;
  }

  :global(button) {
    background: var(--color-bg-button);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: var(--padding-button);
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
  }

  :global(button:hover) {
    background: var(--color-bg-button-hover);
    border-color: var(--color-border-hover);
  }

  .header {
    display: flex;
    justify-content: start;
    align-items: center;
    padding: 0 0.2rem 0.2rem 0.2rem;
  }

  .container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    background: var(--color-bg-container);
  }

  .viewer {
    flex-grow: 1;
    position: relative;
  }

  .export {
    display: flex;
    gap: 0.5rem;
  }

  .export-png {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);

    & input, button {
      border: none;
      border-radius: 0;
    }

  }

  input[type="file"] {
    cursor: pointer;
    background: var(--color-bg-button);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: 0.2rem 0.6rem;
    color: var(--color-text);
  }
</style>
