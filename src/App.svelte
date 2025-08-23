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
import { PhysicalSpotLight, WebGLPathTracer } from "three-gpu-pathtracer"
import { ParallelMeshBVHWorker } from "three-mesh-bvh/src/workers/ParallelMeshBVHWorker.js"
import {
  FillPass,
  //HiddenChainPass,
  SVGMesh,
  SVGRenderer,
  VisibleChainPass,
} from "three-svg-renderer"
import { type GizmoOptions, ViewportGizmo } from "three-viewport-gizmo"
import ProgressBar from "./components/progress_bar.svelte"
import { GeometryRepairer } from "./lib/geometry_fix"

let container: HTMLDivElement | null = null
let progress = $state(0)
let loading = $state(false)

let renderer: THREE.WebGLRenderer
let pathTracer: WebGLPathTracer
let composer: EffectComposer
let sobelPass: ShaderPass
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let gizmo: ViewportGizmo
let loader: GLTFLoader
let currentModel: THREE.Object3D | null = null

let globalLight: THREE.RectAreaLight
let spotLight: PhysicalSpotLight
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
  intensity: 100,
  distance: 10,
  azimuth: 45,
  polar: 45,
}

const viewParams = {
  renderMode: "Raster",
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
        storeOriginalMaps(currentModel)
        storeOriginalMaterialState(currentModel)
        await normalizeAndAddModel(currentModel)
        updateMaterials()
        setModelShadows(currentModel, viewParams.shadows)
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

function focusOnObject(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object)
  const center = new THREE.Vector3()
  box.getCenter(center)
  const size = new THREE.Vector3()
  box.getSize(size)

  controls.target.copy(center)

  const maxDim = Math.max(size.x, size.y, size.z)
  const fov = camera.fov * (Math.PI / 180)
  let cameraZ = Math.abs(maxDim / Math.tan(fov / 2))

  cameraZ *= 1.5 // add a margin
  camera.position.set(
    center.x + cameraZ,
    center.y + cameraZ,
    center.z + cameraZ,
  )
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
  loading = true
  progress = 0
  await pathTracer.setSceneAsync(scene, camera, {
    onProgress: (v: number) => {
      progress = v * 100
    },
  })

  progress = 100
  setTimeout(() => {
    loading = false
    progress = 0
  }, 500)
}

function storeOriginalMaps(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]
      materials.forEach((material: THREE.Material) => {
        if ("map" in material && material.map)
          material.userData.originalMap = material.map
      })
    }
  })
}

function storeOriginalMaterialState(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]

      materials.forEach((material: THREE.Material) => {
        material.userData.original = {
          transparent: material.transparent,
          opacity: material.opacity,
          depthTest: material.depthTest,
          depthWrite: material.depthWrite,
        }
      })
    }
  })
}

function updateMaterials() {
  if (!currentModel) return
  currentModel.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]
      materials.forEach((material: THREE.Material) => {
        if ("map" in material) {
          material.map = viewParams.texturesEnabled
            ? material.userData.originalMap || null
            : null
          material.needsUpdate = true
        }
      })
    }
  })
  pathTracer.updateMaterials()
}

function setModelShadows(model: THREE.Object3D, enabled: boolean) {
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = enabled
      child.receiveShadow = enabled
    }
  })
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

  const internalKeywords = ["root", "roll", "bone"] // /x_root_\d+_0/

  currentModel.traverse((child) => {
    if (child instanceof THREE.Mesh && child.material) {
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material]

      const isInternal = internalKeywords.some((keyword) =>
        child.name.toLowerCase().includes(keyword),
      )
      //const isInternal = child.name.toLowerCase().match(internalPattern) !== null

      materials.forEach((material: THREE.Material) => {
        if (isInternal) {
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
        }
      })
    }
  })
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  await loadModelFromFile(input.files[0])
}

function setupComposer(
  container: HTMLDivElement,
  scene: THREE.Scene,
  camera: THREE.Camera,
) {
  const width = container.clientWidth
  const height = container.clientHeight
  const pixelRatio = Math.min(window.devicePixelRatio, 2)

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

async function renderWithAccumulation(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  passes: number = 16,
  resolutionMultiplier: number = 2,
): Promise<string> {
  // Create a higher quality render target for ray tracing
  const renderTarget = new THREE.WebGLRenderTarget(
    renderer.domElement.width * resolutionMultiplier,
    renderer.domElement.height * resolutionMultiplier,
    {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      samples: 8, // Multi-sampling for anti-aliasing
    },
  )

  // Save current renderer settings
  const originalShadowMap = renderer.shadowMap.enabled
  const originalShadowMapType = renderer.shadowMap.type
  const originalToneMapping = renderer.toneMapping
  const originalExposure = renderer.toneMappingExposure

  // Enable advanced rendering features for ray-traced quality
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2

  // Create temporary camera for high-quality rendering
  const tempCamera = camera.clone()

  let accumBuffer = new THREE.WebGLRenderTarget(
    renderTarget.width,
    renderTarget.height,
    { format: THREE.RGBAFormat, type: THREE.FloatType },
  )

  // Accumulation shader for progressive ray tracing simulation
  const accumMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      tAccum: { value: null },
      frame: { value: 0 },
      opacity: { value: 1.0 / passes },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tAccum;
      uniform float frame;
      uniform float opacity;
      varying vec2 vUv;
      
      void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        vec4 accum = texture2D(tAccum, vUv);
        
        if (frame < 0.5) {
          gl_FragColor = texel;
        } else {
          gl_FragColor = mix(accum, texel, opacity);
        }
      }
    `,
  })

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), accumMaterial)
  const accumScene = new THREE.Scene()
  accumScene.add(quad)
  const accumCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  // Progressive rendering loop
  for (let i = 0; i < passes; i++) {
    // Add slight camera jitter for anti-aliasing (simulates ray sampling)
    tempCamera.position.x = camera.position.x + (Math.random() - 0.5) * 0.001
    tempCamera.position.y = camera.position.y + (Math.random() - 0.5) * 0.001
    tempCamera.position.z = camera.position.z + (Math.random() - 0.5) * 0.001
    tempCamera.lookAt(camera.getWorldDirection(new THREE.Vector3()))

    // Render main scene
    renderer.setRenderTarget(renderTarget)
    renderer.render(scene, tempCamera)

    // Accumulate the result
    accumMaterial.uniforms.tDiffuse.value = renderTarget.texture
    accumMaterial.uniforms.tAccum.value = accumBuffer.texture
    accumMaterial.uniforms.frame.value = i

    const tempTarget = accumBuffer.clone()
    renderer.setRenderTarget(tempTarget)
    renderer.render(accumScene, accumCamera)

    // Swap buffers
    accumBuffer.dispose()
    accumBuffer = tempTarget

    // Allow UI to update
    if (i % 4 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  // Final render to canvas
  renderer.setRenderTarget(null)
  accumMaterial.uniforms.tDiffuse.value = accumBuffer.texture
  accumMaterial.uniforms.frame.value = -1 // Just copy the accumulated result
  renderer.render(accumScene, accumCamera)

  // Get the high-quality image data
  const dataURL = renderer.domElement.toDataURL("image/png", 1.0)

  // Restore original renderer settings
  renderer.shadowMap.enabled = originalShadowMap
  renderer.shadowMap.type = originalShadowMapType
  renderer.toneMapping = originalToneMapping
  renderer.toneMappingExposure = originalExposure

  // Clean up
  renderTarget.dispose()
  accumBuffer.dispose()
  accumMaterial.dispose()
  quad.geometry.dispose()

  return dataURL
}

function downloadImage(dataURL: string, filename: string = "image.png") {
  const link = document.createElement("a")
  link.href = dataURL
  link.download = filename
  link.click()
}

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

async function exportScene(format: "png" | "svg") {
  if (!container || !currentModel) return

  gizmo.visible = false

  if (format === "png") {
    if (viewParams.renderMode === "Raster" || viewParams.lineMode) {
      composer.render()
    } else if (viewParams.renderMode === "Path Tracer") {
      pathTracer.renderSample()
    }

    const dataURL = renderer.domElement.toDataURL("image/png", 1.0)
    downloadImage(dataURL, "scene.png")
  }

  if (format === "svg") {
    const repairer = new GeometryRepairer()
    const modelCopy = currentModel.clone(true)
    await repairer.repairGeometry(modelCopy, {
      mergeTolerance: 1e-5,
    })

    //ground.visible = false
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
    //svgRenderer.addPass(
    //  new HiddenChainPass({ defaultStyle: { color: "#000000", width: 1 } }),
    //)

    svgRenderer
      .generateSVG(svgMeshes, camera, {
        w: container.clientWidth,
        h: container.clientHeight,
      })
      .then((svg) => {
        const blob = new Blob([svg.svg()], {
          type: "image/svg+xml;charset=utf-8",
        })
        const link = document.createElement("a")
        const url = URL.createObjectURL(blob)
        link.href = url
        link.download = "scene.svg"
        link.click()
        URL.revokeObjectURL(url)
      })
  }

  gizmo.visible = true
}

onMount(() => {
  let rafId: number
  let resize: () => void

  async function init() {
    if (!container) return

    const width = container.clientWidth
    const height = container.clientHeight

    renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
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
    camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000)
    camera.position.set(2, 2, 2)

    setupComposer(container, scene, camera)

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

    spotLight = new PhysicalSpotLight(0xffffff, 1000)
    spotLight.position.setFromSpherical(
      new THREE.Spherical(
        spotLightParams.distance,
        spotLightParams.polar,
        spotLightParams.azimuth,
      ),
    )

    spotLight.castShadow = true
    spotLight.shadow.mapSize.set(2048, 2048)
    spotLight.shadow.camera.near = 0.1
    spotLight.shadow.camera.far = 50
    spotLight.shadow.focus = 1.0
    scene.add(spotLight)

    //spotLightHelper = new THREE.SpotLightHelper(spotLight, 0xffffff)
    //scene.add(spotLightHelper)

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
      .add(sceneParams, "globalLight", 0, 3, 0.1)
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
      .add(sceneParams, "surfaceRoughness", 0, 1, 0.01)
      .name("Surface roughness")
      .onChange((value: number) => {
        globalSurfaceMaterial.roughness = value
        globalSurfaceMaterial.needsUpdate = true
        pathTracer.updateMaterials()
      })

    sceneFolder
      .add(sceneParams, "surfaceMetalness", 0, 1, 0.01)
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
          spotLightParams.azimuth,
          spotLightParams.polar,
        )
        spotLight.position.setFromSpherical(spherical)
        pathTracer.updateLights()
      })

    spotLightFolder
      .add(spotLightParams, "azimuth", 0, 360, 1)
      .name("Azimuthal angle")
      .onChange((value: number) => {
        const spherical = new THREE.Spherical(
          spotLightParams.distance,
          spotLightParams.polar,
          THREE.MathUtils.degToRad(value),
        )
        spotLight.position.setFromSpherical(spherical)
        pathTracer.updateLights()
      })

    spotLightFolder
      .add(spotLightParams, "polar", 0, 180, 1)
      .name("Polar angle")
      .onChange((value: number) => {
        const spherical = new THREE.Spherical(
          spotLightParams.distance,
          THREE.MathUtils.degToRad(value),
          spotLightParams.azimuth,
        )
        spotLight.position.setFromSpherical(spherical)
        pathTracer.updateLights()
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
      .add(viewParams, "texturesEnabled")
      .name("Textures")
      .onChange(updateMaterials)

    toolsFolder
      .add(viewParams, "xray")
      .name("X-Ray View")
      .onChange((v: boolean) => {
        toggleXray(v)
      })
    toolsFolder
      .add(viewParams, "lineMode")
      .name("Line Mode")
      .onChange((v: boolean) => {
        if (sobelPass) sobelPass.enabled = v
      })
    toolsFolder
      .add(viewParams, "shadows")
      .name("Shadows")
      .onChange((v: boolean) => {
        renderer.shadowMap.enabled = v
        if (currentModel) setModelShadows(currentModel, v)
        globalSurface.receiveShadow = v
      })
    toolsFolder
      .add(bboxParams, "showBoundingBox")
      .name("Show Bounding Box")
      .onChange((v: boolean) => {
        if (boundingBoxHelper) boundingBoxHelper.visible = v
        dimensionLabels.forEach((l) => {
          l.visible = v
        })
      })

    resize = () => {
      if (!container) return

      const w = container.clientWidth
      const h = container.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      composer.setSize(w, h)
      if (pathTracer) {
        pathTracer.updateCamera()
      }
      if (sobelPass) {
        const pixelRatio = Math.min(window.devicePixelRatio, 2)
        sobelPass.uniforms.resolution.value.x = w * pixelRatio
        sobelPass.uniforms.resolution.value.y = h * pixelRatio
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
        pathTracer.renderSample()
        progress = pathTracer.samples
        loading = pathTracer.isCompiling
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
    if (renderer) {
      renderer.forceContextLoss()
      renderer.domElement?.remove()
      renderer.dispose()
    }
    if (pathTracer && typeof pathTracer.dispose === "function") {
      pathTracer.dispose()
    }
    if (composer) composer.dispose()
    if (currentModel) disposeModel(currentModel)
  }
})
</script>

<div class="container">
  <header class="header">
    <label style="margin: 1rem; color: #eee;">
      Load .glb Model:
      <input type="file" accept=".glb" onchange={onFileChange} style="margin-left: 1rem;" />
    </label>
    <div>
      <button onclick={() => exportScene("png")}>Export PNG</button>
      <button onclick={() => exportScene("svg")}>Export SVG</button>
    </div>
  </header>
  <ProgressBar 
    value={progress}
    visible={loading} 
    top="calc(100% - 0.5rem)"
    left="0"
    barWidth="100%"
    barHeight="0.5rem"
  />

  <div bind:this={container} class="viewer"></div>
</div>

<style>
  :global(body) {
    margin: 0;
    background: #111;
    color: #eee;
    font-family: system-ui, sans-serif;
    overflow: hidden;
  }

  .header {
    display: flex;
    justify-content: start;
    align-items: center;
  }

  .container {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: #222;
  }

  .viewer {
    flex-grow: 1;
    position: relative;
  }

  input[type="file"] {
    cursor: pointer;
    background: #333;
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    color: #eee;
    border: none;
  }
</style>
