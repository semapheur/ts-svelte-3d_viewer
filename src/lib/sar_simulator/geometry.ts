import * as THREE from "three";
import {
  SPEED_OF_LIGHT,
  type ImagingMode,
  type PlatformSample,
  type SarGeometryTransfer,
  type SarPassGeometryData,
} from "./types";

const UP = new THREE.Vector3(0, 1, 0);

interface Options {
  mode: ImagingMode;
  platformSpeed: number;
  apertureDuration: number;
  pulseRepitionFrequency: number;
  centerFrequency: number;
  maxPulses?: number;
}

export function buildSarPassGeometry(
  camera: THREE.Camera,
  target: THREE.Vector3,
  options: Options,
): SarPassGeometryData {
  const platformPos0 = camera.position.clone();
  const sceneCenter = target.clone();

  const radiusVec = platformPos0.clone().sub(sceneCenter);
  const slantRangeToCenter = radiusVec.length();
  if (slantRangeToCenter < 1e-6) {
    throw new Error(
      "Camera is coincident with target; Cannot define SAR geometry",
    );
  }

  const losDir = radiusVec.clone().negate().normalize();

  const nadir = UP.clone().negate();
  const incidenceAngle_rad = Math.acos(
    THREE.MathUtils.clamp(losDir.dot(nadir), -1, 1),
  );

  const horizontalRadius = radiusVec.clone().setY(0);
  if (horizontalRadius.lengthSq() < 1e-8) {
    // Looking straight down: fall back to world +X as an arbitrary azimuth axis
    horizontalRadius.set(1, 0, 0);
  }
  horizontalRadius.normalize();
  const azimuthAxis = new THREE.Vector3()
    .crossVectors(UP, horizontalRadius)
    .normalize();

  const groundRangeAxis = new THREE.Vector3()
    .crossVectors(azimuthAxis, UP)
    .normalize();

  const wavelength_m = SPEED_OF_LIGHT / options.centerFrequency;

  const totalPulsesIdeal = Math.round(
    options.pulseRepitionFrequency * options.apertureDuration,
  );
  const numPulses = Math.max(
    8,
    Math.min(options.maxPulses ?? 512, totalPulsesIdeal || 1),
  );

  const dt = options.apertureDuration / numPulses;

  const orbitRadius = radiusVec.length();
  const angularSpeed = options.platformSpeed / orbitRadius;

  const samples: PlatformSample[] = [];
  const broadsideBoresight = losDir.clone();

  for (let i = 0; i < numPulses; i++) {
    const t = (i - (numPulses - 1) / 2) * dt;
    const theta = angularSpeed * t;

    const pos = radiusVec.clone().applyAxisAngle(UP, theta).add(sceneCenter);

    let boresight: THREE.Vector3;
    if (options.mode === "spotlight") {
      boresight = sceneCenter.clone().sub(pos).normalize();
    } else {
      boresight = broadsideBoresight
        .clone()
        .applyAxisAngle(UP, theta)
        .normalize();
    }

    samples.push({ time: t, position: pos, boresight });
  }

  return {
    samples,
    sceneCenter,
    groundRangeAxis,
    azimuthAxis,
    incidenceAngle_rad,
    slantRangeToCenter,
    wavelength_m,
  };
}

export function toTransferable(geo: SarPassGeometryData): SarGeometryTransfer {
  return {
    samples: geo.samples.map((s) => ({
      time: s.time,
      position: [s.position.x, s.position.y, s.position.z],
      boresight: [s.boresight.x, s.boresight.y, s.boresight.z],
    })),
    sceneCenter: [geo.sceneCenter.x, geo.sceneCenter.y, geo.sceneCenter.z],
    groundRangeAxis: [
      geo.groundRangeAxis.x,
      geo.groundRangeAxis.y,
      geo.groundRangeAxis.z,
    ],
    azimuthAxis: [geo.azimuthAxis.x, geo.azimuthAxis.y, geo.azimuthAxis.z],
    incidenceAngleRad: geo.incidenceAngle_rad,
    slantRangeToCenter: geo.slantRangeToCenter,
    wavelength: geo.wavelength_m,
  };
}

export function fromTransferable(t: SarGeometryTransfer): SarPassGeometryData {
  return {
    samples: t.samples.map((s) => ({
      time: s.time,
      position: new THREE.Vector3(...s.position),
      boresight: new THREE.Vector3(...s.boresight),
    })),
    sceneCenter: new THREE.Vector3(...t.sceneCenter),
    groundRangeAxis: new THREE.Vector3(...t.groundRangeAxis),
    azimuthAxis: new THREE.Vector3(...t.azimuthAxis),
    incidenceAngle_rad: t.incidenceAngleRad,
    slantRangeToCenter: t.slantRangeToCenter,
    wavelength_m: t.wavelength,
  };
}
