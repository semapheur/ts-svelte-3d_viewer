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
