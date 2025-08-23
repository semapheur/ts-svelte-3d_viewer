import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { SobelOperatorShader } from "three/examples/jsm/shaders/SobelOperatorShader.js"

interface SilhouetteSettings {
  threshold?: number
  simplificationTolerance?: number
  strokeWidth?: number
  strokeColor?: string
}

interface Point2D {
  x: number
  y: number
}

type PathPoint = [number, number]
type EdgePath = PathPoint[]

// Custom shader uniforms interface
interface SilhouetteUniforms extends Record<string, { value: any }> {
  tDiffuse: { value: THREE.Texture | null }
  resolution: { value: THREE.Vector2 }
}

// Simplified Edge Detection Pass using built-in Sobel operator
class SimplifiedSilhouettePass extends ShaderPass {
  public declare uniforms: SilhouetteUniforms
  private currentThreshold: number = 0.1

  constructor(width: number, height: number) {
    super(SobelOperatorShader)

    this.uniforms = {
      ...SobelOperatorShader.uniforms,
      resolution: { value: new THREE.Vector2(width, height) },
    } as SilhouetteUniforms

    // Override the fragment shader to output clean black/white edges
    this.material.fragmentShader = this.createFragmentShader(
      this.currentThreshold,
    )
    this.setSize(width, height)
  }

  private createFragmentShader(threshold: number): string {
    return `
      uniform sampler2D tDiffuse;
      uniform vec2 resolution;
      
      varying vec2 vUv;
      
      void main() {
        vec2 texel = vec2(1.0 / resolution.x, 1.0 / resolution.y);
        
        // Sample surrounding pixels
        float tl = length(texture2D(tDiffuse, vUv + texel * vec2(-1, -1)).rgb);
        float tm = length(texture2D(tDiffuse, vUv + texel * vec2( 0, -1)).rgb);
        float tr = length(texture2D(tDiffuse, vUv + texel * vec2( 1, -1)).rgb);
        float ml = length(texture2D(tDiffuse, vUv + texel * vec2(-1,  0)).rgb);
        float mm = length(texture2D(tDiffuse, vUv).rgb);
        float mr = length(texture2D(tDiffuse, vUv + texel * vec2( 1,  0)).rgb);
        float bl = length(texture2D(tDiffuse, vUv + texel * vec2(-1,  1)).rgb);
        float bm = length(texture2D(tDiffuse, vUv + texel * vec2( 0,  1)).rgb);
        float br = length(texture2D(tDiffuse, vUv + texel * vec2( 1,  1)).rgb);
        
        // Sobel X
        float gx = -1.0*tl + 1.0*tr +
                   -2.0*ml + 2.0*mr +
                   -1.0*bl + 1.0*br;
        
        // Sobel Y  
        float gy = -1.0*tl + -2.0*tm + -1.0*tr +
                    1.0*bl +  2.0*bm +  1.0*br;
        
        float g = sqrt(gx*gx + gy*gy);
        
        // Output clean black/white
        float edge = g > ${threshold.toFixed(3)} ? 1.0 : 0.0;
        gl_FragColor = vec4(1.0 - edge, 1.0 - edge, 1.0 - edge, 1.0);
      }
    `
  }

  public setSize(width: number, height: number): void {
    this.uniforms.resolution.value.set(width, height)
  }

  public setThreshold(threshold: number): void {
    this.currentThreshold = threshold
    this.material.fragmentShader = this.createFragmentShader(threshold)
    this.material.needsUpdate = true
  }
}

// Multi-pass edge detection for better results
class MultiPassSilhouetteRenderer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.Camera
  private composer: EffectComposer
  private renderPass: RenderPass
  private sobelPass: SimplifiedSilhouettePass
  private width: number
  private height: number
  private settings: Required<SilhouetteSettings>

  // 8-connected directions for better path connectivity
  private readonly directions: PathPoint[] = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ]

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera

    const size = renderer.getSize(new THREE.Vector2())
    this.width = size.x
    this.height = size.y

    // Create composer for multi-pass rendering
    this.composer = new EffectComposer(renderer)

    // Pass 1: Regular render
    this.renderPass = new RenderPass(scene, camera)
    this.composer.addPass(this.renderPass)

    // Pass 2: Sobel edge detection
    this.sobelPass = new SimplifiedSilhouettePass(this.width, this.height)
    this.composer.addPass(this.sobelPass)

    // Default settings
    this.settings = {
      threshold: 0.1,
      simplificationTolerance: 2.0,
      strokeWidth: 1,
      strokeColor: "#000000",
    }
  }

  public configure(settings: SilhouetteSettings): void {
    Object.assign(this.settings, settings)

    if (settings.threshold !== undefined) {
      this.sobelPass.setThreshold(settings.threshold)
    }
  }

  public setSize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.composer.setSize(width, height)
    this.sobelPass.setSize(width, height)
  }

  private isEdge(x: number, y: number, imageData: Uint8Array): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false
    const idx = (y * this.width + x) * 4
    return imageData[idx] < 128 // Black pixels are edges
  }

  private traceFromPoint(
    startX: number,
    startY: number,
    imageData: Uint8Array,
    visited: boolean[],
  ): EdgePath {
    const path: EdgePath = []
    const queue: PathPoint[] = [[startX, startY]]

    while (queue.length > 0) {
      const point = queue.shift()
      if (!point) continue

      const [x, y] = point
      const idx = y * this.width + x

      if (visited[idx] || !this.isEdge(x, y, imageData)) continue

      visited[idx] = true
      path.push([x, y])

      // Add connected edge pixels
      for (const [dx, dy] of this.directions) {
        const nx = x + dx
        const ny = y + dy
        const nidx = ny * this.width + nx

        if (this.isEdge(nx, ny, imageData) && !visited[nidx]) {
          queue.push([nx, ny])
        }
      }
    }

    return path
  }

  // Enhanced edge tracing with better connectivity
  private traceEdges(imageData: Uint8Array): EdgePath[] {
    const paths: EdgePath[] = []
    const visited = new Array<boolean>(this.width * this.height).fill(false)

    // Find all edge components
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const idx = y * this.width + x
        if (this.isEdge(x, y, imageData) && !visited[idx]) {
          const path = this.traceFromPoint(x, y, imageData, visited)
          if (path.length > 5) {
            // Filter out noise
            paths.push(path)
          }
        }
      }
    }

    return paths
  }

  private perpendicularDistance(
    point: PathPoint,
    lineStart: PathPoint,
    lineEnd: PathPoint,
  ): number {
    const dx = lineEnd[0] - lineStart[0]
    const dy = lineEnd[1] - lineStart[1]

    if (dx === 0 && dy === 0) {
      return Math.sqrt(
        (point[0] - lineStart[0]) ** 2 + (point[1] - lineStart[1]) ** 2,
      )
    }

    const t = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - lineStart[0]) * dx + (point[1] - lineStart[1]) * dy) /
          (dx * dx + dy * dy),
      ),
    )

    const projection: PathPoint = [lineStart[0] + t * dx, lineStart[1] + t * dy]

    return Math.sqrt(
      (point[0] - projection[0]) ** 2 + (point[1] - projection[1]) ** 2,
    )
  }

  private douglasPeucker(points: EdgePath, tolerance: number): EdgePath {
    if (points.length <= 2) return points

    let maxDistance = 0
    let index = 0
    const end = points.length - 1

    for (let i = 1; i < end; i++) {
      const distance = this.perpendicularDistance(
        points[i],
        points[0],
        points[end],
      )
      if (distance > maxDistance) {
        index = i
        maxDistance = distance
      }
    }

    if (maxDistance > tolerance) {
      const left = this.douglasPeucker(points.slice(0, index + 1), tolerance)
      const right = this.douglasPeucker(points.slice(index), tolerance)
      return left.slice(0, -1).concat(right)
    }

    return [points[0], points[end]]
  }

  // Improved Douglas-Peucker with better handling of closed paths
  private simplifyPath(points: EdgePath, tolerance: number): EdgePath {
    if (points.length <= 2) return points

    // Check if path should be closed
    const start = points[0]
    const end = points[points.length - 1]
    const shouldClose =
      Math.abs(start[0] - end[0]) < 3 && Math.abs(start[1] - end[1]) < 3

    const simplified = this.douglasPeucker(points, tolerance)

    // Close path if needed
    if (shouldClose && simplified.length > 3) {
      simplified.push(simplified[0])
    }

    return simplified
  }

  private isClosedPath(path: EdgePath): boolean {
    if (path.length < 4) return false

    const start = path[0]
    const end = path[path.length - 1]

    return start[0] === end[0] && start[1] === end[1]
  }

  private createPathData(path: EdgePath): string {
    if (path.length === 0) return ""

    let pathData = `M ${path[0][0]} ${this.height - path[0][1]}`

    for (let i = 1; i < path.length; i++) {
      pathData += ` L ${path[i][0]} ${this.height - path[i][1]}`
    }

    if (this.isClosedPath(path)) {
      pathData += " Z"
    }

    return pathData
  }

  // Generate SVG with better path handling
  public async generateSVG(): Promise<string> {
    // Render using the composer
    this.composer.render()

    // Read pixels from the final render target
    const renderTarget = this.composer.writeBuffer
    const pixels = new Uint8Array(this.width * this.height * 4)

    this.renderer.readRenderTargetPixels(
      renderTarget,
      0,
      0,
      this.width,
      this.height,
      pixels,
    )

    // Trace edges
    const paths = this.traceEdges(pixels)

    // Generate SVG header
    let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${this.width}" height="${this.height}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}">
  <rect width="100%" height="100%" fill="white"/>
  <g stroke="${this.settings.strokeColor}" stroke-width="${this.settings.strokeWidth}" fill="none" stroke-linejoin="round" stroke-linecap="round">
`

    // Process each path
    for (const path of paths) {
      const simplified = this.simplifyPath(
        path,
        this.settings.simplificationTolerance,
      )

      if (simplified.length > 1) {
        const pathData = this.createPathData(simplified)
        svgContent += `    <path d="${pathData}"/>\n`
      }
    }

    svgContent += `  </g>
</svg>`

    return svgContent
  }

  public async downloadSVG(filename: string = "silhouette.svg"): Promise<void> {
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

  // Getters for accessing internal state
  public get renderSize(): Point2D {
    return { x: this.width, y: this.height }
  }

  public get currentSettings(): Readonly<Required<SilhouetteSettings>> {
    return { ...this.settings }
  }

  // Method to get the effect composer for advanced usage
  public getComposer(): EffectComposer {
    return this.composer
  }
}
