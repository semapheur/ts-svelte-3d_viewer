import * as THREE from "three";

export const SPEED_OF_LIGHT = 299792458;

export type Polarization = "H" | "V";

export interface PolarizationConfig {
  tx: Polarization;
  rx: Polarization;
}

export type ImagingMode = "stripmap" | "spotlight";

export interface SarParams {
  antennaSize_m: number;
  chirpBandwidth_Hz: number;
  centerFrequency_Hz: number;
  pulseRepetition_Hz: number;
  polarization: PolarizationConfig;
  mode: ImagingMode;
  platformSpeed_mps: number;
  apertureDuration_s: number;
  pulseDuration_s?: number;
  rangeOversample?: number;
  maxPulses?: number;
  imageSize?: number;
  maxScatterers?: number;
  eccentricity?: number;
}

export interface Scatterer {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  albedo: number;
}

export interface PlatformSample {
  time: number;
  position: THREE.Vector3;
  boresight: THREE.Vector3;
}

export interface SarPassGeometryData {
  samples: PlatformSample[];
  sceneCenter: THREE.Vector3;
  groundRangeAxis: THREE.Vector3;
  azimuthAxis: THREE.Vector3;
  incidenceAngle_rad: number;
  azimuthAngle_rad: number;
  slantRangeToCenter: number;
  wavelength_m: number;
}

export interface SarStats {
  rangeResolution_m: number;
  azimuthResolution_m: number;
  slantRange_m: number;
  azimuthAngle_rad: number;
  lookAngle_rad: number;
  syntheticAperture_m: number;
}

export interface SarImage {
  width: number;
  height: number;
  data: Float32Array;
  groundRangeExtent_m: number;
  azimuthExtent_m: number;
  min_dB: number;
  max_dB: number;
  stats: SarStats;
}

export interface SarGeometryTransfer {
  samples: {
    time: number;
    position: [number, number, number];
    boresight: [number, number, number];
  }[];
  sceneCenter: [number, number, number];
  groundRangeAxis: [number, number, number];
  azimuthAxis: [number, number, number];
  incidenceAngleRad: number;
  azimuthAngleRad: number;
  slantRangeToCenter: number;
  wavelength: number;
}

export interface SarScattererTransfer {
  position: [number, number, number];
  normal: [number, number, number];
  albedo: number;
}
