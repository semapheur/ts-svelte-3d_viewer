import * as THREE from "three"

export interface SARConfig {
  frequency: number
  bandwidth: number
  pulseWidth: number
  aperturePath: THREE.Vector3[]
  targetCenter: THREE.Vector3
  imageResolution: { width: number; height: number }
  rangeResolution: number
  azimuthResolution: number
}

export class SARSensor {
  private scene: THREE.Scene
  private renderer: THREE.WebGLRenderer
  private renderTarget: THREE.WebGLRenderTarget
  private radarCamera: THREE.PerspectiveCamera
  private material: THREE.ShaderMaterial

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene
    this.renderer = renderer

    this.renderTarget = new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    })

    this.radarCamera = new THREE.PerspectiveCamera(15, 1, 0.1, 1000)

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        frequency: { value: 9.6 },
        time: { value: 0 },
        sensorPosition: { value: new THREE.Vector3() },
        targetPosition: { value: new THREE.Vector3() },
      },
      vertexShader: `
        attribute mat4 modelMatrix;
        attribute mat4 projectionMatrix;
        attribute mat4 modelViewMatrix;
        attribute mat3 normalMatrix;
        attribute vec3 position;
        attribute vec3 normal;
        attribute vec2 uv;
        
        varying vec3 vWorldPosition;
        varying vec3 vNormal;
        varying vec2 vUv;

        void main() {
          vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
          vNormal = normalize(normalMatrix * normal);
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        #define PI 3.1415926535897932384626433832795
        precision mediump float;

        uniform float frequency;
        uniform float time;
        uniform vec3 sensorPosition;
        uniform vec3 targetPosition;

        varying vec3 vWorldPosition;
        varying vec3 vNormal;
        varying vec2 vUv;
        
        float calculateRCS(vec3 normal, vec3 incidentDirection, vec3 position) {
          float cosAngle = dot(normal, -incidentDirection);
          float rcs = max(0.0, cosAngle);

          float roughness = 0.1;
          rcs *= (1.0 + roughness * sin(frequency * length(position) * 100.0));

          return rcs;
        }

        void main() {
          vec3 incidentDirection = normalize(vWorldPosition - sensorPosition);
          float distance = length(vWorldPosition - sensorPosition);

          float rcs = calculateRCS(vNormal, incidentDirection, vWorldPosition);
          float attenuation = 1.0 / (distance * distance);
          float phase = mod(frequency * distance * 2.0, 2.0 * PI);

          float magnitude = rcs * attenuation;
          gl_FragColor = vec4(magnitude * cos(phase), magnitude * sin(phase), distance / 100.0, 1.0);
        }
      `,
    })
  }

  captureRadarReturn(
    sensorPosition: THREE.Vector3,
    targetPosition: THREE.Vector3,
  ): THREE.Texture {
    this.radarCamera.position.copy(sensorPosition)
    this.radarCamera.lookAt(targetPosition)

    this.material.uniforms.sensorPosition.value.copy(sensorPosition)
    this.material.uniforms.targetPosition.value.copy(targetPosition)

    const originalMaterials = new Map<
      THREE.Mesh,
      THREE.Material | THREE.Material[]
    >()
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        originalMaterials.set(child, child.material)
        child.material = this.material
      }
    })

    this.renderer.setRenderTarget(this.renderTarget)
    this.renderer.render(this.scene, this.radarCamera)
    this.renderer.setRenderTarget(null)

    originalMaterials.forEach((material, mesh) => {
      mesh.material = material
    })

    return this.renderTarget.texture.clone()
  }

  dispose() {
    this.renderTarget.dispose()
    this.material.dispose()
  }
}

export class SARProcessor {
  private config: SARConfig
  private radarReturns: THREE.Texture[] = []
  private processedImage: ImageData | null = null

  constructor(config: SARConfig) {
    this.config = config
  }

  addRadarReturn(radarReturn: THREE.Texture) {
    this.radarReturns.push(radarReturn)
  }

  async processSARImage(): Promise<ImageData> {
    const { width, height } = this.config.imageResolution
    const imageData = new ImageData(width, height)

    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")

    if (!context) throw new Error("Failed to get canvas context")

    canvas.width = 512
    canvas.height = 512

    const realPart = new Float32Array(width * height)
    const imagPart = new Float32Array(width * height)

    for (let i = 0; i < this.radarReturns.length; i++) {
      const radarReturn = this.radarReturns[i]
      const sensorPosition = this.config.aperturePath[i]

      await this.accumulateRadarData(
        radarReturn,
        sensorPosition,
        realPart,
        imagPart,
        width,
        height,
      )
    }

    this.performRangeCompression(realPart, imagPart, width, height)
    this.performAzimuthFocusing(realPart, imagPart, width, height)

    for (let i = 0; i < width * height; i++) {
      const magnitude = Math.sqrt(
        realPart[i] * realPart[i] + imagPart[i] * imagPart[i],
      )
      const normalized = Math.min(255, magnitude * 255)

      imageData.data[i * 4 + 0] = normalized
      imageData.data[i * 4 + 1] = normalized
      imageData.data[i * 4 + 2] = normalized
      imageData.data[i * 4 + 3] = 255
    }

    this.processedImage = imageData
    return imageData
  }

  private async accumulateRadarData(
    radarReturn: THREE.Texture,
    sensorPosition: THREE.Vector3,
    realPart: Float32Array,
    imagPart: Float32Array,
    width: number,
    height: number,
  ) {
    const centerX = width / 2
    const centerY = height / 2
    const radius = Math.min(width, height) / 2

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - centerX
        const dy = y - centerY
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (distance >= radius) continue

        const phase =
          (sensorPosition.length() + distance) * this.config.frequency * 0.1
        const amplitude = Math.exp(-distance * 0.01) * 0.1

        const idx = y * width + x

        realPart[idx] += amplitude * Math.cos(phase)
        imagPart[idx] += amplitude * Math.sin(phase)
      }
    }
  }

  private performRangeCompression(
    realPart: Float32Array,
    imagPart: Float32Array,
    width: number,
    height: number,
  ) {
    const kernel = new Float32Array(5)
    kernel[0] = -0.1
    kernel[1] = -0.2
    kernel[2] = 1.0
    kernel[3] = -0.2
    kernel[4] = -0.1

    this.applyFilterHorizontal(realPart, kernel, width, height)
    this.applyFilterHorizontal(imagPart, kernel, width, height)
  }

  private performAzimuthFocusing(
    realPart: Float32Array,
    imagPart: Float32Array,
    width: number,
    height: number,
  ) {
    const kernel = new Float32Array(7)

    for (let i = 0; i < 7; i++) {
      kernel[i] =
        Math.exp(-((i - 3) * (i - 3)) / 2.0) / Math.sqrt(2.0 * Math.PI)
    }

    this.applyFilterVertical(realPart, kernel, width, height)
    this.applyFilterVertical(imagPart, kernel, width, height)
  }

  private applyFilterHorizontal(
    data: Float32Array,
    kernel: Float32Array,
    width: number,
    height: number,
  ) {
    const temp = new Float32Array(data)
    const kernelRadius = Math.floor(kernel.length / 2)

    for (let y = 0; y < height; y++) {
      for (let x = kernelRadius; x < width - kernelRadius; x++) {
        let sum = 0
        for (let k = 0; k < kernel.length; k++) {
          const px = x + k - kernelRadius
          sum += temp[y * width + px] * kernel[k]
        }
        data[y * width + x] = sum
      }
    }
  }

  private applyFilterVertical(
    data: Float32Array,
    kernel: Float32Array,
    width: number,
    height: number,
  ) {
    const temp = new Float32Array(data)
    const kernelRadius = Math.floor(kernel.length / 2)

    for (let x = 0; x < width; x++) {
      for (let y = kernelRadius; y < height - kernelRadius; y++) {
        let sum = 0
        for (let k = 0; k < kernel.length; k++) {
          const py = y + k - kernelRadius
          sum += temp[py * width + x] * kernel[k]
        }
        data[y * width + x] = sum
      }
    }
  }

  getProcessedImage(): ImageData | null {
    return this.processedImage
  }

  dispose() {
    this.radarReturns.forEach((texture) => {
      texture.dispose()
    })
    this.radarReturns = []
  }
}

export class SARSimulation {
  private sensor: SARSensor
  private processor: SARProcessor
  private config: SARConfig

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    config: Partial<SARConfig>,
  ) {
    this.config = {
      frequency: 9.6,
      bandwidth: 100,
      pulseWidth: 1.0,
      aperturePath: [],
      targetCenter: new THREE.Vector3(0, 0, 0),
      imageResolution: { width: 512, height: 512 },
      rangeResolution: 1.5,
      azimuthResolution: 1.5,
      ...config,
    }

    this.sensor = new SARSensor(scene, renderer)
    this.processor = new SARProcessor(this.config)
  }

  setLinearAperturePath(
    startPosition: THREE.Vector3,
    endPosition: THREE.Vector3,
    samples: number,
  ) {
    const path: THREE.Vector3[] = []
    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1)
      const position = startPosition.clone().lerp(endPosition, t)
      path.push(position)
    }
    this.config.aperturePath = path
    this.processor = new SARProcessor(this.config)
  }

  setCircularAperturePath(
    center: THREE.Vector3,
    radius: number,
    height: number,
    samples: number,
  ) {
    const path: THREE.Vector3[] = []
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2
      const x = center.x + radius * Math.cos(angle)
      const y = center.y + height
      const z = center.z + radius * Math.sin(angle)
      path.push(new THREE.Vector3(x, y, z))
    }
    this.config.aperturePath = path
    this.processor = new SARProcessor(this.config)
  }

  async simulateSAR(
    onProgress?: (progress: number) => void,
  ): Promise<ImageData> {
    const path = this.config.aperturePath

    if (path.length === 0) {
      throw new Error("Aperture path is empty")
    }

    for (let i = 0; i < path.length; i++) {
      const sensorPosition = path[i]
      const radarReturn = this.sensor.captureRadarReturn(
        sensorPosition,
        this.config.targetCenter,
      )
      this.processor.addRadarReturn(radarReturn)

      if (onProgress) {
        const progress = ((i + 1) / path.length) * 0.8
        onProgress(progress)
      }
    }
    if (onProgress) onProgress(0.9)

    const sarImage = await this.processor.processSARImage()
    if (onProgress) onProgress(1.0)

    return sarImage
  }

  updateConfig(newConfig: Partial<SARConfig>) {
    this.config = { ...this.config, ...newConfig }
    this.processor = new SARProcessor(this.config)
  }

  dispose() {
    this.sensor.dispose()
    this.processor.dispose()
  }
}
