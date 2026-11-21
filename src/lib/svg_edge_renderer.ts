import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { SVGRenderer } from "three/addons/renderers/SVGRenderer.js"

interface EdgeSVGSettings {
  // Edge detection settings
  threshold?: number
  edgeWidth?: number

  // SVG rendering settings
  strokeWidth?: number
  strokeColor?: string
  fillColor?: string

  // Hybrid mode settings
  mode?: "edges-only" | "wireframe"
  useNativeWireframe?: boolean
  simplificationTolerance?: number
}

// Edge detection material for masking
class EdgeDetectionMaterial extends THREE.ShaderMaterial {
  constructor(width: number, height: number, threshold: number = 0.1) {
    super({
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(width, height) },
        threshold: { value: threshold },
      },
      vertexShader: `
        attribute vec2 uv;
        attribute vec3 position;
        varying vec2 vUv;
        uniform mat4 projectionMatrix;
        uniform mat4 modelViewMatrix;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform float threshold;
        varying vec2 vUv;
        
        void main() {
          vec2 texel = 1.0 / resolution;
          
          // Sample surrounding pixels
          float tl = length(texture2D(tDiffuse, vUv + texel * vec2(-1, -1)).rgb);
          float tm = length(texture2D(tDiffuse, vUv + texel * vec2( 0, -1)).rgb);
          float tr = length(texture2D(tDiffuse, vUv + texel * vec2( 1, -1)).rgb);
          float ml = length(texture2D(tDiffuse, vUv + texel * vec2(-1,  0)).rgb);
          float mr = length(texture2D(tDiffuse, vUv + texel * vec2( 1,  0)).rgb);
          float bl = length(texture2D(tDiffuse, vUv + texel * vec2(-1,  1)).rgb);
          float bm = length(texture2D(tDiffuse, vUv + texel * vec2( 0,  1)).rgb);
          float br = length(texture2D(tDiffuse, vUv + texel * vec2( 1,  1)).rgb);
          
          // Sobel edge detection
          float gx = -tl + tr - 2.0*ml + 2.0*mr - bl + br;
          float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;
          float edge = sqrt(gx*gx + gy*gy);
          
          // Output edge mask
          gl_FragColor = vec4(vec3(edge > threshold ? 1.0 : 0.0), 1.0);
        }
      `,
    })
  }

  setThreshold(threshold: number): void {
    this.uniforms.threshold.value = threshold
  }

  setResolution(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height)
  }
}

// Hybrid SVG Renderer that combines both approaches
export class EdgeSVGRenderer {
  private webglRenderer: THREE.WebGLRenderer
  private svgRenderer: SVGRenderer
  private scene: THREE.Scene
  private camera: THREE.Camera
  private width: number
  private height: number
  private settings: Required<EdgeSVGSettings>

  // Edge detection components
  private composer!: EffectComposer
  private renderPass!: RenderPass
  private edgeDetectionMaterial!: EdgeDetectionMaterial
  private edgeTarget!: THREE.WebGLRenderTarget

  // Material storage
  private originalMaterials = new Map<
    THREE.Object3D,
    THREE.Material | THREE.Material[]
  >()

  constructor(
    webglRenderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.webglRenderer = webglRenderer
    this.scene = scene
    this.camera = camera

    const size = webglRenderer.getSize(new THREE.Vector2())
    this.width = size.x
    this.height = size.y

    // Initialize SVG renderer
    this.svgRenderer = new SVGRenderer()
    this.svgRenderer.setSize(this.width, this.height)

    // Initialize edge detection
    this.setupEdgeDetection()

    // Default settings
    this.settings = {
      threshold: 0.1,
      edgeWidth: 1.0,
      strokeWidth: 1,
      strokeColor: "#000000",
      fillColor: "none",
      mode: "edges-only",
      useNativeWireframe: true,
      simplificationTolerance: 1.0,
    }
  }

  private setupEdgeDetection(): void {
    // Setup composer for edge detection
    this.composer = new EffectComposer(this.webglRenderer)
    this.renderPass = new RenderPass(this.scene, this.camera)
    this.composer.addPass(this.renderPass)

    // Edge detection material
    this.edgeDetectionMaterial = new EdgeDetectionMaterial(
      this.width,
      this.height,
    )

    // Edge detection render target
    this.edgeTarget = new THREE.WebGLRenderTarget(this.width, this.height)
  }

  public configure(settings: EdgeSVGSettings): void {
    Object.assign(this.settings, settings)

    if (settings.threshold !== undefined) {
      this.edgeDetectionMaterial.setThreshold(settings.threshold)
    }
  }

  public setSize(width: number, height: number): void {
    this.width = width
    this.height = height

    this.svgRenderer.setSize(width, height)
    this.composer.setSize(width, height)
    this.edgeDetectionMaterial.setResolution(width, height)
    this.edgeTarget.setSize(width, height)
  }

  private createWireframeMaterial(
    color: string = this.settings.strokeColor,
  ): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
      color: color,
      linewidth: this.settings.strokeWidth,
    })
  }

  private createEdgesMaterial(
    geometry: THREE.BufferGeometry,
    color: string = this.settings.strokeColor,
  ): THREE.LineSegments {
    const edges = new THREE.EdgesGeometry(geometry)
    const material = new THREE.LineBasicMaterial({
      color: color,
      linewidth: this.settings.strokeWidth,
    })
    return new THREE.LineSegments(edges, material)
  }

  // Apply wireframe materials to meshes
  private applyWireframeMode(): void {
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Store original material
        this.originalMaterials.set(child, child.material)

        if (this.settings.useNativeWireframe) {
          // Use wireframe property
          const wireframeMaterial = Array.isArray(child.material)
            ? child.material.map((mat) => ({
                ...mat,
                wireframe: true,
                color: new THREE.Color(this.settings.strokeColor),
              }))
            : {
                ...child.material,
                wireframe: true,
                color: new THREE.Color(this.settings.strokeColor),
              }
          child.material = wireframeMaterial as THREE.Material
        } else {
          // Use LineSegments for better control
          const wireframeMaterial = this.createWireframeMaterial()
          child.material = wireframeMaterial
        }
      }
    })
  }

  // Apply edge-based materials using geometry edges
  private applyEdgesMode(): void {
    const edgeObjects: THREE.LineSegments[] = []

    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        // Hide original mesh
        child.visible = false

        // Create edge representation
        const edgeLines = this.createEdgesMaterial(child.geometry)
        edgeLines.applyMatrix4(child.matrixWorld)
        edgeObjects.push(edgeLines)
      }
    })

    // Add edge objects to a temporary group
    const edgeGroup = new THREE.Group()
    edgeObjects.forEach((edge) => {
      edgeGroup.add(edge)
    })
    this.scene.add(edgeGroup)

    // Store for cleanup
    ;(this.scene as any)._edgeGroup = edgeGroup
  }

  // Restore original materials
  private restoreMaterials(): void {
    this.originalMaterials.forEach((material, child) => {
      if (child instanceof THREE.Mesh) {
        child.material = material
        child.visible = true
      }
    })
    this.originalMaterials.clear()

    // Remove edge group if exists
    const edgeGroup = (this.scene as any)._edgeGroup
    if (edgeGroup) {
      this.scene.remove(edgeGroup)
      delete (this.scene as any)._edgeGroup
    }
  }

  // Generate SVG using Three.js SVGRenderer
  private renderWithSVGRenderer(): string {
    const svgElement = this.svgRenderer.domElement
    this.svgRenderer.render(this.scene, this.camera)

    // Get SVG content
    const serializer = new XMLSerializer()
    let svgString = serializer.serializeToString(svgElement)

    // Enhance SVG with proper styling
    svgString = this.enhanceSVGStyling(svgString)

    return svgString
  }

  private enhanceSVGStyling(svgString: string): string {
    // Add proper styling attributes
    const styleAttributes =
      `stroke="${this.settings.strokeColor}" ` +
      `stroke-width="${this.settings.strokeWidth}" ` +
      `fill="${this.settings.fillColor}" ` +
      `stroke-linejoin="round" stroke-linecap="round"`

    // Apply styling to paths and lines
    svgString = svgString.replace(/<path/g, `<path ${styleAttributes}`)
    svgString = svgString.replace(/<line/g, `<line ${styleAttributes}`)
    svgString = svgString.replace(/<polyline/g, `<polyline ${styleAttributes}`)

    return svgString
  }

  // Main SVG generation method
  public async generateSVG(): Promise<string> {
    try {
      const mode = this.settings.mode

      if (mode === "wireframe") {
        // Use Three.js SVGRenderer with wireframe
        this.applyWireframeMode()
        const svgContent = this.renderWithSVGRenderer()
        this.restoreMaterials()
        return svgContent
      } else if (mode === "edges-only") {
        // Use Three.js SVGRenderer with edges
        this.applyEdgesMode()
        const svgContent = this.renderWithSVGRenderer()
        this.restoreMaterials()
        return svgContent
      } else {
        throw new Error(`Unknown render mode: ${mode}`)
      }
    } catch (error) {
      this.restoreMaterials() // Ensure cleanup on error
      throw error
    }
  }

  // Download SVG file
  public async downloadSVG(
    filename: string = "hybrid-silhouette.svg",
  ): Promise<void> {
    const svgContent = await this.generateSVG()

    const blob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" })
    const link = document.createElement("a")
    const url = URL.createObjectURL(blob)

    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // Get current settings
  public get currentSettings(): Readonly<Required<EdgeSVGSettings>> {
    return { ...this.settings }
  }

  // Get render size
  public get renderSize(): { x: number; y: number } {
    return { x: this.width, y: this.height }
  }

  // Access to SVGRenderer for advanced usage
  public getSVGRenderer(): SVGRenderer {
    return this.svgRenderer
  }

  // Access to WebGL renderer
  public getWebGLRenderer(): THREE.WebGLRenderer {
    return this.webglRenderer
  }
}
