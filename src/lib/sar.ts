import * as THREE from "three";
import sarVertexShader from "../shaders/sar.vert.glsl";
import sarFragmentShader from "../shaders/sar.frag.glsl";

export type Polarization = "HH" | "VV" | "HV" | "VH";
export type SARMode = "stripmap" | "spotlight";

export interface SARParams {
  enabled: boolean;
  centerFreqGHz: number;
  bandwidthMHz: number;
  prfHz: number;
  polarization: Polarization;
  mode: SARMode;
  durationSec: number;
  speedMps: number;
  headingDeg: number;
  antennaLengthM: number;
  speckleLevel: number;
  dbMin: number;
  dbMax: number;
}

export const SARShader = {
  uniforms: {
    t_diffuse: { value: null },
    t_depth: { value: null },
    u_resolution: { value: new THREE.Vector2() },
    u_cameraNear: { value: 0.1 },
    u_cameraFar: { value: 1000.0 },
    u_radarPos: { value: new THREE.Vector3() },
    u_targetPos: { value: new THREE.Vector3() },
    u_flightDir: { value: new THREE.Vector3() },
    u_wavelength: { value: 0.031 }, // c / f_c (m)
    u_rangeRes: { value: 0.5 }, // c / (2 * Bandwidth)
    u_azimuthRes: { value: 1.0 }, // Mode dependent (m)
    u_polarization: { value: 0 }, // 0: HH, 1: VV, 2: HV, 3: VH
    u_speckleLevel: { value: 0.3 },
    u_dbMin: { value: -30.0 },
    u_dbMax: { value: 10.0 },
  },
  vertexShader: sarVertexShader,
  fragmentShader: sarFragmentShader,
};
