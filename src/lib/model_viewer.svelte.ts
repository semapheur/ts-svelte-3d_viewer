import { GUI } from "lil-gui";
import * as THREE from "three/webgpu";
import { WebGLRenderer } from "three";
import { pass } from "three/tsl";
import { sobel } from "three/addons/tsl/display/SobelOperatorNode.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";
import { WebGPUPathTracer } from "three-gpu-pathtracer/webgpu";
import { ParallelMeshBVHWorker } from "three-mesh-bvh/worker";
import {
  FillPass,
  SVGMesh,
  SVGRenderer,
  VisibleChainPass,
} from "three-svg-renderer";
import { type GizmoOptions, ViewportGizmo } from "three-viewport-gizmo";
import { generateVisibleEdgesSVG } from "./generate_svg";
import { GeometryRepairer } from "./geometry_fix";

// missing function in three.js
(THREE.Triangle as any).getUV = (
  point: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  uv1: THREE.Vector2,
  uv2: THREE.Vector2,
  uv3: THREE.Vector2,
  target: THREE.Vector2,
) => {
  const barycoord = new THREE.Vector3();
  THREE.Triangle.getBarycoord(point, p1, p2, p3, barycoord);

  target.set(
    uv1.x * barycoord.x + uv2.x * barycoord.y + uv3.x * barycoord.z,
    uv1.y * barycoord.x + uv2.y * barycoord.y + uv3.y * barycoord.z,
  );
  return target;
};

// `PostProcessing` was renamed to `RenderPipeline` in newer three.js releases.
// Resolve whichever one this version exposes.
const PipelineClass: new (renderer: THREE.WebGPURenderer) => any =
  (THREE as any).RenderPipeline ?? (THREE as any).PostProcessing;

const BACKGROUND_COLOR = "#222222";

export class ModelViewer {
  progress = $state<number>(0);
  loadingProgress = $state<boolean>(false);
  loadingSpinner = $state<boolean>(false);

  #canvas: HTMLCanvasElement;
  #renderer!: THREE.WebGPURenderer;
  #gizmoRenderer!: WebGLRenderer;
  #gizmoCanvas!: HTMLCanvasElement;
  #pathTracer!: WebGPUPathTracer;
  #pipeline: any;
  #scene!: THREE.Scene;
  #camera!: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  #perspectiveCamera!: THREE.PerspectiveCamera;
  #orthographicCamera!: THREE.OrthographicCamera;
  #controls!: OrbitControls;
  #gizmo!: ViewportGizmo;
  #loader!: GLTFLoader;
  #currentModel: THREE.Object3D | null = null;

  #globalLight!: THREE.RectAreaLight;
  #spotLight!: THREE.SpotLight;
  #spotLightHelper!: THREE.SpotLightHelper;
  #grid!: THREE.GridHelper;
  #globalSurface!: THREE.Mesh;
  #globalSurfaceMaterial!: THREE.MeshStandardMaterial;
  #gui: GUI | null = null;

  #boundingBoxHelper: THREE.BoxHelper | null = null;
  #dimensionLabels: THREE.Sprite[] = [];

  #initialized = false;
  #disposed = false;
  #pathTracerSceneDirty = true;
  #frustumSize = 5;

  #sceneParams = {
    backgroundColor: BACKGROUND_COLOR,
    globalLight: 2.0,
    showGrid: true,
    gridSize: 10,
    showSurface: true,
    surfaceRoughness: 1.0,
    surfaceMetalness: 0.0,
  };

  #spotLightParams = {
    showHelper: false,
    intensity: 500,
    distance: 10,
    azimuth: 45,
    polar: 45,
  };

  #viewParams = {
    renderMode: "Raster",
    camera: "Perspective",
    texturesEnabled: true,
    xray: false,
    lineMode: false,
    shadows: true,
  };

  #bboxParams = { showBoundingBox: false };

  #resizeHandler = () => this.resize();
  #pathTracerControlListener = () => this.#pathTracer?.updateCamera();

  get camera() {
    return this.#camera;
  }

  get controls() {
    return this.#controls;
  }

  get scene() {
    return this.#scene;
  }

  get #isPathTracing() {
    return this.#viewParams.renderMode === "Path Tracer";
  }

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  async init() {
    if (!("gpu" in navigator)) {
      console.warn(
        "WebGPU is not available in this browser. WebGPURenderer will fall back to its WebGL2 backend and the path tracer will not work.",
      );
    }

    const width = this.#canvas.clientWidth;
    const height = this.#canvas.clientHeight;
    const aspect = width / height;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    this.#renderer = new THREE.WebGPURenderer({
      canvas: this.#canvas,
      antialias: true,
      trackTimestamp: true,
    });
    // WebGPURenderer must be initialised asynchronously before use.
    await this.#renderer.init();
    if (this.#disposed) {
      this.#renderer.dispose();
      return;
    }

    this.#renderer.setPixelRatio(pixelRatio);
    this.#renderer.setSize(width, height, false);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.#renderer.toneMappingExposure = 1.0;
    this.#renderer.shadowMap.enabled = this.#viewParams.shadows;
    this.#renderer.shadowMap.type = THREE.PCFShadowMap;

    this.#scene = new THREE.Scene();
    this.#scene.background = new THREE.Color(0x222222);

    this.#perspectiveCamera = new THREE.PerspectiveCamera(
      50,
      aspect,
      0.01,
      1000,
    );
    this.#orthographicCamera = new THREE.OrthographicCamera(
      (this.#frustumSize * aspect) / -2,
      (this.#frustumSize * aspect) / 2,
      this.#frustumSize / 2,
      this.#frustumSize / -2,
      0.01,
      1000,
    );
    this.#orthographicCamera.zoom = 1;
    this.#orthographicCamera.updateProjectionMatrix();

    this.#camera =
      this.#viewParams.camera === "Perspective"
        ? this.#perspectiveCamera
        : this.#orthographicCamera;
    this.#camera.position.set(2, 2, 2);

    this.#setupPipeline();
    this.#setupLights();
    this.#setupEnvironment();

    this.#pathTracer = new WebGPUPathTracer(this.#renderer);
    // setBVHWorker expects a worker *constructor*; the tracer creates its own instances.
    this.#pathTracer.setBVHWorker(ParallelMeshBVHWorker);
    // Adaptive frame budget needs GPU timestamp queries, which not every device offers.
    if (!(this.#renderer as any).backend?.trackTimestamp) {
      this.#pathTracer.adaptiveFrameBudget = false;
    }

    this.#controls = new OrbitControls(this.#camera, this.#renderer.domElement);
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.07;
    this.#controls.screenSpacePanning = false;

    this.#setupGizmo();

    this.#loader = new GLTFLoader();

    this.#setupGUI();

    window.addEventListener("resize", this.#resizeHandler);
    this.#initialized = true;
    this.#renderer.setAnimationLoop(this.#animate);
  }

  /**
   * ViewportGizmo draws with its own LineMaterial (a ShaderMaterial), which
   * WebGPURenderer cannot compile. It gets its own transparent WebGL canvas,
   * stacked on top of the main one.
   */
  #setupGizmo() {
    this.#gizmoCanvas = document.createElement("canvas");
    this.#gizmoCanvas.style.position = "absolute";
    this.#gizmoCanvas.style.pointerEvents = "none";
    this.#canvas.after(this.#gizmoCanvas);

    this.#gizmoRenderer = new WebGLRenderer({
      canvas: this.#gizmoCanvas,
      alpha: true,
      antialias: true,
    });
    this.#gizmoRenderer.setClearColor(0x000000, 0);
    this.#syncGizmoCanvas();

    const gizmoOptions: GizmoOptions = {
      placement: "bottom-right",
      container: this.#canvas.parentElement ?? document.body,
    };
    this.#gizmo = new ViewportGizmo(
      this.#camera,
      this.#gizmoRenderer,
      gizmoOptions,
    );
    this.#gizmo.attachControls(this.#controls);
  }

  #syncGizmoCanvas() {
    const { clientWidth: w, clientHeight: h } = this.#canvas;
    this.#gizmoCanvas.style.left = `${this.#canvas.offsetLeft}px`;
    this.#gizmoCanvas.style.top = `${this.#canvas.offsetTop}px`;
    this.#gizmoCanvas.style.width = `${w}px`;
    this.#gizmoCanvas.style.height = `${h}px`;
    this.#gizmoRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#gizmoRenderer.setSize(w, h, false);
  }

  /**
   * EffectComposer does not work with WebGPURenderer. Post-processing is done
   * with a node based pipeline instead. Toggling "Line Mode" swaps its output
   * node between the plain scene pass and a Sobel edge filter of it.
   */
  #setupPipeline() {
    this.#pipeline = new PipelineClass(this.#renderer);
    this.#buildPipeline();
  }

  #buildPipeline() {
    const scenePass = pass(this.#scene, this.#camera);
    this.#pipeline.outputNode = this.#viewParams.lineMode
      ? sobel(scenePass)
      : scenePass;
    this.#pipeline.needsUpdate = true;
  }

  #setupLights() {
    // WebGPU needs the LTC lookup textures for RectAreaLight.
    (THREE as any).RectAreaLightNode?.setLTC?.(RectAreaLightTexturesLib.init());

    this.#globalLight = new THREE.RectAreaLight(
      0xffffff,
      this.#sceneParams.globalLight,
      1000,
      1000,
    );
    this.#globalLight.position.set(0, 100, 0);
    this.#globalLight.lookAt(0, 0, 0);
    this.#scene.add(this.#globalLight);

    this.#spotLight = new THREE.SpotLight(
      0xffffff,
      this.#spotLightParams.intensity,
    );
    this.#spotLight.position.setFromSpherical(
      new THREE.Spherical(
        this.#spotLightParams.distance,
        THREE.MathUtils.degToRad(this.#spotLightParams.polar),
        THREE.MathUtils.degToRad(this.#spotLightParams.azimuth),
      ),
    );
    this.#spotLight.castShadow = true;
    this.#spotLight.shadow.mapSize.set(2 ** 12, 2 ** 12);
    this.#spotLight.shadow.camera.near = 0.5;
    this.#spotLight.shadow.camera.far = 100;
    this.#spotLight.shadow.camera.fov = 30;
    this.#spotLight.shadow.focus = 1.0;
    this.#spotLight.shadow.bias = 0.0001;
    this.#spotLight.shadow.normalBias = 0.05;
    this.#spotLight.shadow.radius = 10;
    this.#scene.add(this.#spotLight);

    this.#spotLightHelper = new THREE.SpotLightHelper(
      this.#spotLight,
      0xffffff,
    );
    this.#spotLightHelper.visible = this.#spotLightParams.showHelper;
    this.#scene.add(this.#spotLightHelper);
  }

  #setupEnvironment() {
    this.#grid = new THREE.GridHelper(10, 20, 0x444444, 0x111111);
    this.#scene.add(this.#grid);

    const surfaceGeometry = new THREE.PlaneGeometry(1000, 1000);
    this.#globalSurfaceMaterial = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 1.0,
      metalness: 0.0,
    });
    this.#globalSurface = new THREE.Mesh(
      surfaceGeometry,
      this.#globalSurfaceMaterial,
    );
    this.#globalSurface.rotation.x = -Math.PI / 2;
    this.#globalSurface.position.y = -0.01;
    this.#globalSurface.receiveShadow = true;
    this.#scene.add(this.#globalSurface);
  }

  /** Only touch the path tracer when it is actually the active render mode. */
  #ptUpdateLights() {
    if (this.#isPathTracing) this.#pathTracer.updateLights();
  }

  #ptUpdateMaterials() {
    if (this.#isPathTracing) this.#pathTracer.updateMaterials();
  }

  #setupGUI() {
    this.#gui = new GUI();

    const sceneFolder = this.#gui.addFolder("Scene");
    sceneFolder
      .add(this.#sceneParams, "globalLight", 0.0, 5.0, 0.1)
      .name("Global Light")
      .onChange((value: number) => {
        this.#globalLight.intensity = value;
        this.#ptUpdateLights();
      });

    sceneFolder
      .addColor(this.#sceneParams, "backgroundColor")
      .name("Background color")
      .onChange((value: string) => {
        this.#scene.background = new THREE.Color(value);
      });

    sceneFolder
      .add(
        {
          reset: () => {
            this.#sceneParams.backgroundColor = BACKGROUND_COLOR;
            this.#scene.background = new THREE.Color(BACKGROUND_COLOR);
          },
        },
        "reset",
      )
      .name("Reset background");

    sceneFolder
      .add(this.#sceneParams, "showGrid")
      .name("Show Grid")
      .onChange((value: boolean) => {
        this.#grid.visible = value;
      });

    sceneFolder
      .add(this.#sceneParams, "gridSize", 10, 100, 10)
      .name("Grid Size")
      .onChange((value: number) => {
        this.#scene.remove(this.#grid);
        this.#grid.dispose();
        this.#grid = new THREE.GridHelper(value, value * 2, 0x444444, 0x111111);
        this.#grid.position.y = -0.01;
        this.#grid.visible = this.#sceneParams.showGrid;
        this.#scene.add(this.#grid);
        this.#markPathTracerSceneDirty();
      });

    sceneFolder
      .add(this.#sceneParams, "showSurface")
      .name("Show Surface")
      .onChange((value: boolean) => {
        this.#globalSurface.visible = value;
        this.#markPathTracerSceneDirty();
      });

    sceneFolder
      .add(this.#sceneParams, "surfaceRoughness", 0.0, 1.0, 0.01)
      .name("Surface roughness")
      .onChange((value: number) => {
        this.#globalSurfaceMaterial.roughness = value;
        this.#globalSurfaceMaterial.needsUpdate = true;
        this.#ptUpdateMaterials();
      });

    sceneFolder
      .add(this.#sceneParams, "surfaceMetalness", 0.0, 1.0, 0.01)
      .name("Surface metalness")
      .onChange((value: number) => {
        this.#globalSurfaceMaterial.metalness = value;
        this.#globalSurfaceMaterial.needsUpdate = true;
        this.#ptUpdateMaterials();
      });

    const spotLightFolder = this.#gui.addFolder("Spot light");
    spotLightFolder
      .add(this.#spotLightParams, "intensity", 0, 1000, 10)
      .name("Intensity")
      .onChange((value: number) => {
        this.#spotLight.intensity = value;
        this.#ptUpdateLights();
      });

    spotLightFolder
      .add(this.#spotLightParams, "distance", 0, 100, 1)
      .name("Distance")
      .onChange(() => this.#updateSpotLightSpherical());

    spotLightFolder
      .add(this.#spotLightParams, "azimuth", 0, 360, 1)
      .name("Azimuthal angle")
      .onChange(() => this.#updateSpotLightSpherical());

    spotLightFolder
      .add(this.#spotLightParams, "polar", 0, 180, 1)
      .name("Polar angle")
      .onChange(() => this.#updateSpotLightSpherical());

    spotLightFolder
      .add(this.#spotLightParams, "showHelper")
      .name("Show Helper")
      .onChange((value: boolean) => {
        this.#spotLightHelper.visible = value;
      });

    const toolsFolder = this.#gui.addFolder("Tools");
    toolsFolder
      .add(this.#viewParams, "renderMode", ["Raster", "Path Tracer"])
      .name("Render Mode")
      .onChange(async (mode: string) => {
        if (mode === "Raster") {
          this.#controls.removeEventListener(
            "change",
            this.#pathTracerControlListener,
          );
        } else {
          this.#controls.addEventListener(
            "change",
            this.#pathTracerControlListener,
          );
          if (this.#pathTracerSceneDirty) await this.#setPathTracerScene();
          this.#pathTracer.reset();
        }
      });

    toolsFolder
      .add(this.#viewParams, "camera", ["Perspective", "Orthographic"])
      .name("Camera")
      .onChange((mode: string) => this.#switchCamera(mode));

    toolsFolder
      .add(this.#viewParams, "texturesEnabled")
      .name("Textures")
      .onChange(() => this.#updateMaterials());

    toolsFolder
      .add(this.#viewParams, "xray")
      .name("X-Ray View")
      .onChange((value: boolean) => this.#toggleXray(value));

    toolsFolder
      .add(this.#viewParams, "lineMode")
      .name("Line Mode")
      .onChange(() => this.#buildPipeline());

    toolsFolder
      .add(this.#viewParams, "shadows")
      .name("Shadows")
      .onChange((value: boolean) => {
        this.#renderer.shadowMap.enabled = value;
        if (this.#currentModel)
          this.#setModelShadows(this.#currentModel, value);
        this.#globalSurface.receiveShadow = value;
      });

    toolsFolder
      .add(this.#bboxParams, "showBoundingBox")
      .name("Show Bounding Box")
      .onChange((value: boolean) => {
        if (this.#boundingBoxHelper) this.#boundingBoxHelper.visible = value;
        this.#dimensionLabels.forEach((l) => (l.visible = value));
      });
  }

  #updateSpotLightSpherical() {
    const spherical = new THREE.Spherical(
      this.#spotLightParams.distance,
      THREE.MathUtils.degToRad(this.#spotLightParams.polar),
      THREE.MathUtils.degToRad(this.#spotLightParams.azimuth),
    );
    this.#spotLight.position.setFromSpherical(spherical);
    this.#spotLightHelper.update();
    this.#ptUpdateLights();
  }

  async #switchCamera(mode: string) {
    const oldPosition = this.#camera.position.clone();
    const oldTarget = this.#controls.target.clone();

    this.#camera =
      mode === "Perspective"
        ? this.#perspectiveCamera
        : this.#orthographicCamera;
    this.#camera.position.copy(oldPosition);
    this.#camera.updateProjectionMatrix();

    this.#controls.object = this.#camera;
    this.#controls.target.copy(oldTarget);
    this.#controls.update();

    this.#gizmo.camera = this.#camera;
    this.#gizmo.update();

    // The scene pass holds a reference to the camera, so rebuild it.
    this.#buildPipeline();

    if (this.#isPathTracing) {
      this.#pathTracer.reset();
      await this.#setPathTracerScene();
    } else {
      this.#pathTracerSceneDirty = true;
    }
  }

  async resize() {
    if (!this.#initialized) return;

    const width = this.#canvas.clientWidth;
    const height = this.#canvas.clientHeight;
    const aspect = width / height;

    if (this.#camera instanceof THREE.PerspectiveCamera) {
      this.#camera.aspect = aspect;
    } else {
      this.#orthographicCamera.left = (-this.#frustumSize * aspect) / 2;
      this.#orthographicCamera.right = (this.#frustumSize * aspect) / 2;
      this.#orthographicCamera.top = this.#frustumSize / 2;
      this.#orthographicCamera.bottom = -this.#frustumSize / 2;
    }

    this.#camera.updateProjectionMatrix();
    // The post-processing pipeline follows the renderer size automatically.
    this.#renderer.setSize(width, height, false);
    this.#syncGizmoCanvas();

    // Rebuilding the path tracer scene is expensive, so only do it when needed.
    if (this.#isPathTracing) await this.#setPathTracerScene();
    else this.#pathTracerSceneDirty = true;

    this.#gizmo.update();
  }

  #animate = () => {
    this.#controls.update();
    this.#updateLabelPositions();
    this.#updateGlobalSurfaceAndLight();

    if (!this.#isPathTracing || this.#viewParams.lineMode) {
      this.#pipeline.render();
    } else {
      if (this.#pathTracer.isCompiling) {
        this.#pipeline.render();
        this.progress = this.#pathTracer.samples;
        this.loadingSpinner = true;
      } else {
        this.loadingSpinner = false;
        this.#pathTracer.renderSample();
      }
    }

    this.#gizmo.render();
  };

  async loadModelFromFile(file: File) {
    if (!this.#loader) return;
    if (this.#currentModel) {
      this.#scene.remove(this.#currentModel);
      this.#disposeModel(this.#currentModel);
      this.#currentModel = null;
    }

    const arrayBuffer = await file.arrayBuffer();
    this.#loader.parse(
      arrayBuffer,
      "",
      async (gltf) => {
        this.#currentModel = gltf.scene || gltf.scenes?.[0] || null;
        if (!this.#currentModel) return;

        this.#processMaterials(this.#currentModel);
        await this.#addModel(this.#currentModel);
        this.#updateMaterials();
        this.#focusOnObject(this.#currentModel);
        this.#addBoundingBoxAndLabels(this.#currentModel);
      },
      (error) => console.error("Error parsing GLB from file:", error),
    );
  }

  #processMaterials(object: THREE.Object3D) {
    const maxAnisotropy = this.#renderer.getMaxAnisotropy();
    const allMeshes: THREE.Mesh[] = [];

    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        allMeshes.push(child);
      }
    });

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      child.userData.isInterior = this.#isInteriorMesh(child, allMeshes);

      child.castShadow = true;
      child.receiveShadow = true;

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      materials.forEach((material: THREE.Material) => {
        if (!(material instanceof THREE.MeshStandardMaterial)) {
          return;
        }

        if (material.map) {
          material.depthWrite = true;
          material.depthTest = true;

          material.userData.original = {
            map: material.map,
            transparent: material.transparent,
            opacity: material.opacity,
            depthWrite: material.depthWrite,
            depthTest: material.depthTest,
          };
        }

        material.alphaToCoverage = true;

        [
          material.map,
          material.normalMap,
          material.roughnessMap,
          material.metalnessMap,
          material.aoMap,
        ].forEach((tex) => {
          if (tex) {
            tex.anisotropy = maxAnisotropy;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
          }
        });

        material.needsUpdate = true;
      });
    });
  }

  #isInteriorMesh(targetMesh: THREE.Mesh, allMeshes: THREE.Mesh[]): boolean {
    const targetBox = new THREE.Box3().setFromObject(targetMesh);
    const targetCenter = targetBox.getCenter(new THREE.Vector3());

    for (const mesh of allMeshes) {
      if (mesh === targetMesh) continue;

      const meshBox = new THREE.Box3().setFromObject(mesh);

      if (meshBox.containsBox(targetBox)) {
        return true;
      }

      if (this.#isPointInsideMesh(targetCenter, mesh)) {
        return true;
      }
    }

    return false;
  }

  #isPointInsideMesh(point: THREE.Vector3, mesh: THREE.Mesh): boolean {
    const raycaster = new THREE.Raycaster();
    const direction = new THREE.Vector3(1, 0, 0);
    raycaster.set(point, direction);
    const intersects = raycaster.intersectObject(mesh, false);

    return intersects.length % 2 === 1;
  }

  #focusOnObject(object: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(object);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    this.#controls.target.copy(center);

    const maxDim = Math.max(size.x, size.y, size.z);

    if (this.#camera instanceof THREE.PerspectiveCamera) {
      // Perspective camera - calculate distance based on FOV
      const fov = this.#camera.fov * (Math.PI / 180);
      let cameraZ = Math.abs(maxDim / Math.tan(fov / 2));
      cameraZ *= 1.5; // add a margin

      this.#camera.position.set(
        center.x + cameraZ,
        center.y + cameraZ,
        center.z + cameraZ,
      );
    } else if (this.#camera instanceof THREE.OrthographicCamera) {
      // Orthographic camera - adjust zoom instead of distance
      const margin = 1.5;
      const requiredZoom = Math.min(
        (this.#camera.right - this.#camera.left) / (size.x * margin),
        (this.#camera.top - this.#camera.bottom) / (size.y * margin),
      );

      this.#camera.zoom = Math.max(requiredZoom, 0.1); // prevent zero/negative zoom
      this.#camera.updateProjectionMatrix();

      // Still move the camera position for better 3D perspective
      const distance = maxDim * 2; // arbitrary distance for good 3D view
      this.#camera.position.set(
        center.x + distance,
        center.y + distance,
        center.z + distance,
      );
    }

    this.#camera.lookAt(center);
    this.#controls.update();
  }

  async #addModel(model: THREE.Object3D) {
    this.#scene.add(model);
    this.#markPathTracerSceneDirty();
    if (this.#isPathTracing) await this.#setPathTracerScene();
  }

  #updateMaterials() {
    if (!this.#currentModel) return;
    this.#currentModel.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      materials.forEach((material: THREE.Material) => {
        if (
          !(material instanceof THREE.MeshStandardMaterial) ||
          !("map" in material) ||
          !("original" in material.userData)
        )
          return;

        material.map = this.#viewParams.texturesEnabled
          ? material.userData.original.map || null
          : null;
        material.needsUpdate = true;
      });
    });
    this.#ptUpdateMaterials();
  }

  #updateLabelPositions() {
    if (!this.#currentModel || !this.#currentModel.userData.bbox) return;
    const { wLabel, hLabel, lLabel } = this.#currentModel.userData.bbox;

    const updatedBox = new THREE.Box3().setFromObject(this.#currentModel);
    const size = updatedBox.getSize(new THREE.Vector3());
    const center = updatedBox.getCenter(new THREE.Vector3());

    const cameraPos = this.#camera.position.clone();

    const nearestX =
      cameraPos.x > center.x ? center.x + size.x / 2 : center.x - size.x / 2;
    const nearestY =
      cameraPos.y > center.y ? center.y + size.y / 2 : center.y - size.y / 2;
    const nearestZ =
      cameraPos.z > center.z ? center.z + size.z / 2 : center.z - size.z / 2;

    const offset = size.length() * 0.05;

    const lengthOffset = cameraPos.z > center.z ? offset : -offset;
    wLabel.position.set(center.x, center.y, nearestZ + lengthOffset);

    const heightOffset = cameraPos.y > center.y ? offset : -offset;
    hLabel.position.set(center.x, nearestY + heightOffset, center.z);

    const widthOffset = cameraPos.x > center.x ? offset : -offset;
    lLabel.position.set(nearestX + widthOffset, center.y, center.z);

    this.#dimensionLabels.forEach((label) => {
      label.quaternion.copy(this.#camera.quaternion);
    });
  }

  #updateGlobalSurfaceAndLight() {
    if (!this.#camera) return;

    if (this.#globalLight) {
      this.#globalLight.position.x =
        Math.floor(this.#camera.position.x / 10) * 10;
      this.#globalLight.position.z =
        Math.floor(this.#camera.position.z / 10) * 10;
    }

    if (this.#globalSurface) {
      this.#globalSurface.position.x =
        Math.floor(this.#camera.position.x / 10) * 10;
      this.#globalSurface.position.z =
        Math.floor(this.#camera.position.z / 10) * 10;

      // Optional: Update texture offset for seamless movement
      if (this.#globalSurfaceMaterial.map) {
        const offsetX = (this.#camera.position.x % 10) / 10;
        const offsetZ = (this.#camera.position.z % 10) / 10;
        this.#globalSurfaceMaterial.map.offset.set(offsetX, offsetZ);
      }
    }
  }

  #toggleXray(enabled: boolean) {
    if (!this.#currentModel) return;

    this.#currentModel.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      if (child.material) {
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];

        const isInternal = child.userData.isInterior as boolean;

        materials.forEach((material: THREE.Material) => {
          if (!isInternal) return;

          if (enabled) {
            child.renderOrder = 2;
            material.depthTest = false;
            material.depthWrite = false;
            material.transparent = true;
            material.opacity = 0.8;
          } else {
            const original = material.userData.original;
            if (original) {
              material.transparent = original.transparent;
              material.opacity = original.opacity;
              material.depthTest = original.depthTest;
              material.depthWrite = original.depthWrite;
            }
            child.renderOrder = 0;
          }
          material.needsUpdate = true;
        });
      }
    });
  }

  #setModelShadows(model: THREE.Object3D, enabled: boolean) {
    model.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = enabled;
        child.receiveShadow = enabled;
      }
    });
  }

  #addBoundingBoxAndLabels(object: THREE.Object3D) {
    if (this.#boundingBoxHelper) this.#scene.remove(this.#boundingBoxHelper);
    this.#dimensionLabels.forEach((l) => {
      this.#scene.remove(l);
    });
    this.#dimensionLabels = [];

    const box = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    this.#boundingBoxHelper = new THREE.BoxHelper(object, 0xff0000);
    this.#boundingBoxHelper.visible = this.#bboxParams.showBoundingBox;
    this.#scene.add(this.#boundingBoxHelper);

    const wLabel = this.#makeTextSprite(`W: ${size.x.toFixed(2)}`);
    const hLabel = this.#makeTextSprite(`H: ${size.y.toFixed(2)}`);
    const lLabel = this.#makeTextSprite(`L: ${size.z.toFixed(2)}`);

    this.#dimensionLabels.push(wLabel, hLabel, lLabel);
    this.#dimensionLabels.forEach((l) => {
      l.visible = this.#bboxParams.showBoundingBox;
      this.#scene.add(l);
    });

    object.userData.bbox = { wLabel, hLabel, lLabel };
    this.#markPathTracerSceneDirty();
  }

  #makeTextSprite(message: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to get canvas context");

    const fontSize = 20;
    const scaleFactor = 4;
    const pixelRatio = (window.devicePixelRatio || 1) * scaleFactor;

    context.font = `${fontSize}px Arial`;
    const metrics = context.measureText(message);
    const textWidth = metrics.width;

    const padding = 8;
    const width = textWidth + padding * 2;
    const height = fontSize + padding * 2;

    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    context.scale(pixelRatio, pixelRatio);

    context.font = `${fontSize}px Arial`;
    context.fillStyle = "white";
    context.strokeStyle = "black";
    context.lineWidth = 1;
    context.textAlign = "center";
    context.textBaseline = "middle";

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    const centerX = width / 2;
    const centerY = height / 2;

    context.strokeText(message, centerX, centerY);
    context.fillText(message, centerX, centerY);

    const texture = new THREE.CanvasTexture(canvas);
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
    });
    const sprite = new THREE.Sprite(material);

    const aspect = canvas.width / canvas.height;
    const baseScale = 1;
    sprite.scale.set(baseScale * aspect, baseScale, 1);
    return sprite;
  }

  #disposeModel(obj: THREE.Object3D | null) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose();
        if (child.material) {
          const mat = child.material;
          if (Array.isArray(mat))
            mat.forEach((m) => {
              m.dispose();
            });
          else mat.dispose();
        }
      }
    });
  }

  #markPathTracerSceneDirty() {
    this.#pathTracerSceneDirty = true;
  }

  async #setPathTracerScene() {
    this.loadingProgress = true;
    this.progress = 0;
    try {
      await this.#pathTracer.setSceneAsync(this.#scene, this.#camera, {
        onProgress: (v: number) => {
          this.progress = v * 100;
        },
      });
      this.#pathTracerSceneDirty = false;
      this.progress = 100;
    } catch (error) {
      console.error("Failed to build path tracer scene:", error);
    } finally {
      setTimeout(() => {
        this.loadingProgress = false;
        this.progress = 0;
      }, 500);
    }
  }

  async exportPng(resolutionScale: number | null) {
    if (!this.#currentModel || !resolutionScale) return;
    this.#gizmo.visible = false;

    try {
      if (this.#isPathTracing) {
        this.#pathTracer.renderSample();
        this.#downloadImage(
          this.#renderer.domElement.toDataURL("image/png", 1.0),
          "scene.png",
        );
        return;
      }

      const basePixelRatio = Math.min(window.devicePixelRatio, 2);
      const clientWidth = this.#canvas.clientWidth;
      const clientHeight = this.#canvas.clientHeight;
      const needsUpdate = resolutionScale !== 1;

      // Scale through the pixel ratio so the restore step is exact.
      if (needsUpdate) {
        this.#renderer.setPixelRatio(basePixelRatio * resolutionScale);
        this.#renderer.setSize(clientWidth, clientHeight, false);
      }

      // Render and read back in the same task: a WebGPU canvas texture is
      // only guaranteed to hold its content until the task ends.
      this.#pipeline.render();
      this.#downloadImage(
        this.#renderer.domElement.toDataURL("image/png", 1.0),
        "scene.png",
      );

      if (needsUpdate) {
        this.#renderer.setPixelRatio(basePixelRatio);
        this.#renderer.setSize(clientWidth, clientHeight, false);
      }
    } finally {
      this.#gizmo.visible = true;
    }
  }

  async exportSvg() {
    if (!this.#currentModel) return;
    this.#gizmo.visible = false;

    try {
      const viewBox = this.#boundingSvgSize(this.#currentModel);
      let svg = "";

      try {
        const repairer = new GeometryRepairer();
        const modelCopy = this.#currentModel.clone(true);
        const results = await repairer.repairGeometry(modelCopy, {
          mergeTolerance: 1e-5,
        });

        if ((results.finalAnalysis.totalStats.totalIssues ?? 0) > 0) {
          throw new Error(
            "Model has issues preventing SVG export using 'three-svg-renderer'",
          );
        }

        const svgMeshes: SVGMesh[] = [];
        modelCopy.traverse((child) => {
          if (child instanceof THREE.Mesh) svgMeshes.push(new SVGMesh(child));
        });

        const svgRenderer = new SVGRenderer();
        svgRenderer.addPass(new FillPass());
        svgRenderer.addPass(
          new VisibleChainPass({
            defaultStyle: { color: "#000000", width: 1 },
          }),
        );

        const svgElement = await svgRenderer.generateSVG(
          svgMeshes,
          this.#camera,
          {
            w: viewBox.width,
            h: viewBox.height,
          },
        );
        svg = svgElement.svg();
      } catch (error) {
        console.warn("Reverting to fallback SVG renderer: ", error);
        svg = await generateVisibleEdgesSVG(this.#scene, this.#camera, {
          width: viewBox.width,
          height: viewBox.height,
          fullWidth: this.#canvas.clientWidth,
          fullHeight: this.#canvas.clientHeight,
          offsetX: viewBox.minX,
          offsetY: viewBox.minY,
          lineColor: "#000000",
          lineWidth: 1,
          edgeThreshold: 1,
          depthTestSamples: 2,
          depthBias: 1e-4,
        });
      }

      if (!svg) throw new Error("Failed to generate SVG with both renderers");

      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      this.#downloadImage(url, "scene.svg");
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      this.#gizmo.visible = true;
    }
  }

  #boundingSvgSize(model: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(model);
    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];
    const projected = corners.map((c) => {
      const p = c.clone().project(this.#camera);
      return {
        x: ((p.x + 1) * this.#canvas.clientWidth) / 2,
        y: ((-p.y + 1) * this.#canvas.clientHeight) / 2,
      };
    });
    const minX = Math.min(...projected.map((p) => p.x));
    const maxX = Math.max(...projected.map((p) => p.x));
    const minY = Math.min(...projected.map((p) => p.y));
    const maxY = Math.max(...projected.map((p) => p.y));
    return {
      minX,
      minY,
      width: Math.ceil(maxX - minX),
      height: Math.ceil(maxY - minY),
    };
  }

  #downloadImage(dataURL: string, filename = "image.png") {
    const link = document.createElement("a");
    link.href = dataURL;
    link.download = filename;
    link.click();
  }

  dispose() {
    this.#disposed = true;
    window.removeEventListener("resize", this.#resizeHandler);

    if (this.#renderer) this.#renderer.setAnimationLoop(null);

    if (this.#gui) {
      this.#gui.destroy();
      this.#gui = null;
    }
    if (this.#controls) {
      this.#controls.removeEventListener(
        "change",
        this.#pathTracerControlListener,
      );
      this.#controls.dispose();
    }
    if (this.#gizmo) this.#gizmo.dispose();
    if (this.#gizmoRenderer) this.#gizmoRenderer.dispose();
    if (this.#gizmoCanvas) this.#gizmoCanvas.remove();
    if (this.#pathTracer && typeof this.#pathTracer.dispose === "function") {
      this.#pathTracer.dispose();
    }
    if (this.#pipeline && typeof this.#pipeline.dispose === "function") {
      this.#pipeline.dispose();
    }
    if (this.#currentModel) this.#disposeModel(this.#currentModel);
    // WebGPURenderer has no forceContextLoss(); dispose() releases its resources.
    if (this.#renderer) this.#renderer.dispose();
  }
}
