import * as THREE from "three";
import type { Scatterer, SarScattererTransfer } from "./types";

export interface SampleOptions {
  maxScatterers?: number;
  excludeNames?: Set<string>;
}
const _color = new THREE.Color();
const tmpVec = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

export function sampleSceneScatterers(
  scene: THREE.Object3D,
  options: SampleOptions = {},
): Scatterer[] {
  const maxScatterers = options.maxScatterers ?? 3000;
  const exclude = options.excludeNames ?? new Set<string>();

  const candidateMeshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && !exclude.has(obj.name)) {
      candidateMeshes.push(obj as THREE.Mesh);
    }
  });

  let totalVerts = 0;
  for (const mesh of candidateMeshes) {
    const pos = mesh.geometry.getAttribute("position");
    if (pos) totalVerts += pos.count;
  }

  if (totalVerts === 0) return [];
  const stride = Math.max(1, Math.floor(totalVerts / maxScatterers));

  const scatterers: Scatterer[] = [];
  const normalMatrix = new THREE.Matrix3();

  for (const mesh of candidateMeshes) {
    mesh.updateWorldMatrix(true, false);
    const geom = mesh.geometry;
    const posAttr = geom.getAttribute("position") as
      THREE.BufferAttribute | undefined;
    const normAttr = geom.getAttribute("normal") as
      THREE.BufferAttribute | undefined;
    const colorAttr = geom.getAttribute("color") as
      THREE.BufferAttribute | undefined;

    if (!posAttr) continue;

    normalMatrix.getNormalMatrix(mesh.matrixWorld);

    let materialAlbedo = 0.6;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (mat && (mat as THREE.MeshStandardMaterial).color) {
      _color.copy((mat as THREE.MeshStandardMaterial).color);
      materialAlbedo =
        0.15 +
        0.7 * (0.2126 * _color.r + 0.7152 * _color.g + 0.0722 * _color.b);
    }
    for (let i = 0; i < posAttr.count; i += stride) {
      tmpVec.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);

      if (normAttr) {
        tmpNormal
          .fromBufferAttribute(normAttr, i)
          .applyMatrix3(normalMatrix)
          .normalize();
      } else {
        tmpNormal.set(0, 1, 0);
      }

      let albedo = materialAlbedo;
      if (colorAttr) {
        const r = colorAttr.getX(i),
          g = colorAttr.getY(i),
          b = colorAttr.getZ(i);

        albedo = 0.15 + 0.7 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
      }

      scatterers.push({
        position: tmpVec.clone(),
        normal: tmpNormal.clone(),
        albedo,
      });

      if (scatterers.length >= maxScatterers) return scatterers;
    }
  }

  return scatterers;
}

export function toTransferable(
  scatterers: Scatterer[],
): SarScattererTransfer[] {
  return scatterers.map((s) => ({
    position: [s.position.x, s.position.y, s.position.z],
    normal: [s.normal.x, s.normal.y, s.normal.z],
    albedo: s.albedo,
  }));
}

export function fromTransferable(arr: SarScattererTransfer[]): Scatterer[] {
  return arr.map((s) => ({
    position: new THREE.Vector3(...s.position),
    normal: new THREE.Vector3(...s.normal),
    albedo: s.albedo,
  }));
}
