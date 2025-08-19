<script lang="ts">
import { GUI } from "lil-gui"
import { onDestroy, onMount } from "svelte"
import * as THREE from "three"
import { OrbitControls } from "three/addons/controls/OrbitControls.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { SobelOperatorShader } from "three/addons/shaders/SobelOperatorShader.js"
import { WebGPURenderer } from "three/webgpu"
import {
  FillPass,
  HiddenChainPass,
  SVGMesh,
  SVGRenderer,
  VisibleChainPass,
} from "three-svg-renderer"
import { type GizmoOptions, ViewportGizmo } from "three-viewport-gizmo"
import { GeometryRepairer } from "./lib/geometry_fix"

let container: HTMLDivElement | null = null

let renderer: THREE.WebGLRenderer
let composer: EffectComposer
let sobelPass: ShaderPass
let scene: THREE.Scene
let camera: THREE.PerspectiveCamera
let controls: OrbitControls
let gizmo: ViewportGizmo
let loader: GLTFLoader
let currentModel: THREE.Object3D | null = null

let light: THREE.AmbientLight
let dirLight: THREE.DirectionalLight
let grid: THREE.GridHelper
let ground: THREE.Mesh
let gui: GUI | null = null

let boundingBoxHelper: THREE.BoxHelper | null = null
let dimensionLabels: THREE.Sprite[] = []
const bboxParams = { showBoundingBox: false }

const backgroundColor = "#222222"

const bgParams = {
  color: "#222222",
}

const lightParams = {
  ambientIntensity: 0.6,
  dirIntensity: 0.8,
  dirX: 5,
  dirY: 10,
  dirZ: 7.5,
}

const materialParams = {
  metalness: 0.0,
  roughness: 0.7,
  texturesEnabled: true,
}

const viewParams = {
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

function loadModelFromFile(file: File) {
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
      (gltf) => {
        currentModel = gltf.scene || gltf.scenes?.[0] || null
        if (!currentModel) return
        storeOriginalMaps(currentModel)
        storeOriginalMaterialState(currentModel)
        normalizeAndAddModel(currentModel)
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

function normalizeAndAddModel(model: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z)
  if (maxDim > 0) model.scale.setScalar(1.0 / maxDim)
  scene.add(model)
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
        if ("metalness" in material)
          material.metalness = materialParams.metalness
        if ("roughness" in material)
          material.roughness = materialParams.roughness
        if ("map" in material)
          material.map = materialParams.texturesEnabled
            ? material.userData.originalMap || null
            : null

        material.needsUpdate = true
      })
    }
  })
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
          console.log(child.children)
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

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files || input.files.length === 0) return
  loadModelFromFile(input.files[0])
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap // Soft shadows
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

async function renderWithPathTracing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  resolutionMultiplier: number = 2,
): Promise<string | undefined> {
  if (!navigator.gpu) return

  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) {
    console.warn("Failed to get GPU adapter")
    return
  }

  const device = await adapter.requestDevice()

  const pathTracingRenderer = new WebGPURenderer({
    canvas: document.createElement("canvas"),
    device: device,
    antialias: true,
  })

  pathTracingRenderer.setSize(
    renderer.domElement.width * resolutionMultiplier,
    renderer.domElement.height * resolutionMultiplier,
  )

  pathTracingRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  pathTracingRenderer.toneMapping = THREE.ACESFilmicToneMapping
  pathTracingRenderer.toneMappingExposure = 1.0

  await pathTracingRenderer.renderAsync(scene, camera)
  return pathTracingRenderer.domElement.toDataURL("image/png")
}

function downloadImage(dataURL: string, filename: string = "image.png") {
  const link = document.createElement("a")
  link.href = dataURL
  link.download = filename
  link.click()
}

async function exportScene(format: "png" | "svg") {
  if (!container || !currentModel) return

  grid.visible = false
  gizmo.visible = false

  try {
    if (format === "png") {
      let dataURL: string | undefined

      try {
        //dataURL = await renderWithPathTracing(renderer, scene, camera)
        if (dataURL === undefined) {
          throw new Error("WebGPU path tracing failed.")
        }
      } catch (error) {
        console.warn(
          "WebGPU path tracing not available, falling back to accumulation method:",
          error,
        )
        dataURL = await renderWithAccumulation(renderer, scene, camera)
      }

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
        new VisibleChainPass({ defaultStyle: { color: "#ffffff", width: 1 } }),
      )
      svgRenderer.addPass(
        new HiddenChainPass({ defaultStyle: { color: "#ffffff", width: 1 } }),
      )

      svgRenderer
        .generateSVG(svgMeshes, camera, {
          w: container.clientWidth,
          h: container.clientHeight,
        })
        .then((svg) => {
          const blob = new Blob([svg.toString()], {
            type: "image/svg+xml;charset=utf-8",
          })
          const link = document.createElement("a")
          const url = URL.createObjectURL(blob)
          link.href = url
          link.download = "scene.svg"
          link.click()
          URL.revokeObjectURL(url)
        })

      ground.visible = true
    }
  } finally {
    grid.visible = true
    gizmo.visible = true
  }
}

let rafId: number

onMount(() => {
  if (!container) return

  const width = container.clientWidth
  const height = container.clientHeight

  // renderer
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
  light = new THREE.AmbientLight(0xffffff, lightParams.ambientIntensity)
  scene.add(light)

  dirLight = new THREE.DirectionalLight(0xffffff, lightParams.dirIntensity)
  dirLight.position.set(lightParams.dirX, lightParams.dirY, lightParams.dirZ)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(2048, 2048)
  dirLight.shadow.camera.near = 0.01
  dirLight.shadow.camera.far = 50
  dirLight.shadow.camera.left = -10
  dirLight.shadow.camera.right = 10
  dirLight.shadow.camera.top = 10
  dirLight.shadow.camera.bottom = -10
  dirLight.shadow.bias = -0.0005
  dirLight.shadow.normalBias = 0.02
  scene.add(dirLight)

  // grid
  grid = new THREE.GridHelper(10, 20, 0x444444, 0x111111)
  scene.add(grid)

  // ground plane
  const groundGeo = new THREE.PlaneGeometry(50, 50)
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x222222,
    roughness: 1.0,
  })
  ground = new THREE.Mesh(groundGeo, groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.01
  ground.receiveShadow = true
  scene.add(ground)

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

  const backgroundFolder = gui.addFolder("Background")
  backgroundFolder
    .addColor(bgParams, "color")
    .name("BG Color")
    .onChange((value: string) => {
      scene.background = new THREE.Color(value)
    })

  backgroundFolder
    .add(
      {
        reset: () => {
          bgParams.color = backgroundColor
          scene.background = new THREE.Color(backgroundColor)
        },
      },
      "reset",
    )
    .name("Reset BG")

  const lightFolder = gui.addFolder("Lights")
  lightFolder
    .add(lightParams, "ambientIntensity", 0, 2, 0.01)
    .name("Ambient Light")
    .onChange((value: number) => {
      light.intensity = value
    })
  lightFolder
    .add(lightParams, "dirIntensity", 0, 2, 0.01)
    .name("Directional Light")
    .onChange((value: number) => {
      dirLight.intensity = value
    })
  lightFolder
    .add(lightParams, "dirX", -20, 20, 0.1)
    .name("Dir X")
    .onChange((value: number) => {
      dirLight.position.x = value
    })

  lightFolder
    .add(lightParams, "dirY", -20, 20, 0.1)
    .name("Dir Y")
    .onChange((value: number) => {
      dirLight.position.y = value
    })

  lightFolder
    .add(lightParams, "dirZ", -20, 20, 0.1)
    .name("Dir Z")
    .onChange((value: number) => {
      dirLight.position.z = value
    })

  const materialFolder = gui.addFolder("Materials")
  materialFolder
    .add(materialParams, "metalness", 0, 1, 0.01)
    .name("Metalness")
    .onChange(updateMaterials)
  materialFolder
    .add(materialParams, "roughness", 0, 1, 0.01)
    .name("Roughness")
    .onChange(updateMaterials)
  materialFolder
    .add(materialParams, "texturesEnabled")
    .name("Textures")
    .onChange(updateMaterials)

  const toolsFolder = gui.addFolder("Tools")
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
      ground.receiveShadow = v
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

  const resize = () => {
    if (!container) return

    const w = container.clientWidth
    const h = container.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    composer.setSize(w, h)
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
    composer.render()
    gizmo.render()
    rafId = requestAnimationFrame(animate)
  }
  animate()

  return () => {
    window.removeEventListener("resize", resize)
    gui?.destroy()
    gui = null
  }
})

onDestroy(() => {
  cancelAnimationFrame(rafId)
  if (renderer) {
    renderer.forceContextLoss()
    renderer.domElement?.remove()
    renderer.dispose()
  }
  if (currentModel) disposeModel(currentModel)
})
</script>

<div class="container">
  <header class="header">
    <label style="margin: 1rem; color: #eee;">
      Load .glb Model:
      <input type="file" accept=".glb" on:change={onFileChange} style="margin-left: 1rem;" />
    </label>
    <div>
      <button on:click={() => exportScene("png")}>Export PNG</button>
      <button on:click={() => exportScene("svg")}>Export SVG</button>
    </div>
  </header>
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
