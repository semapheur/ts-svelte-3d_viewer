#include <packing>

uniform sampler2D t_diffuse;
uniform sampler2D t_depth;
uniform vec2 u_resolution;
uniform float u_cameraNear;
uniform float u_cameraFar;
uniform vec3 u_radarPos;
uniform vec3 u_targetPos;
uniform vec3 u_flightDir;
uniform float u_wavelength;
uniform float u_rangeRes;
uniform float u_azimuthRes;
uniform int u_polarization;
uniform float u_speckleLevel;
uniform float u_dbMin;
uniform float u_dbMax;

varying vec2 vUv;

// Pseudo-random noise generator for speckle simulation
float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// Rayleigh distributed speckle noise
float rayleighNoise(vec2 uv) {
  float u = clamp(rand(uv), 1e-6, 1.0 - 1e-6);
  return sqrt(-2.0 * log(u));
}

float getLinearDepth(vec2 uv) {
  float fragCoordZ = texture2D(t_depth, uv).x;
  float viewZ = perspectiveDepthToViewZ(fragCoordZ, u_cameraNear, u_cameraFar);
  return viewZToOrthographicDepth(viewZ, u_cameraNear, u_cameraFar);
}

void main() {
  vec4 baseColor = texture2D(t_diffuse, vUv);
  float depth = getLinearDepth(vUv);

  // Reconstruct screen normal gradient (edge reflectivity)
  vec2 texel = 1.0 / u_resolution;
  float depthN = getLinearDepth(vUv + vec2(0.0, texel.y));
  float depthE = getLinearDepth(vUv + vec2(texel.x, 0.0));

  vec3 dX = vec3(texel.x, 0.0, depthE - depth);
  vec3 dY = vec3(0.0, texel.y, depthN - depth);
  vec3 normal = normalize(cross(dX, dY));

  // Compute radar look vector
  vec3 lookDir = normalize(u_targetPos - u_radarPos);
  float incidenceAngle = acos(clamp(dot(normal, -lookDir), 0.0, 1.0));

  // Radar backscatter model (Bracalente / cosine law approximation)
  float sigma0 = pow(cos(incidenceAngle), 2.0);

  // Polarization factor
  if (u_polarization == 0) { // HH
    sigma0 *= (1.0 + 0.5 * cos(2.0 * incidenceAngle));
  } else if (u_polarization == 1) { // VV
    sigma0 *= (1.0 + 0.8 * sin(incidenceAngle));
  } else { // HV/VH cross-polarization
    sigma0 *= 0.15 * sin(incidenceAngle);
  }

  // Resolution cell blurring
  vec2 blurUv = vec2(u_rangeRes / 100.0, u_azimuthRes / 100.0);
  float sampleSum = sigma0;
  sampleSum += pow(cos(acos(clamp(dot(normal, -lookDir), 0.0, 1.0))), 2.0);
  sigma0 = sampleSum * 0.5;

  // Speckle noise
  if (u_speckleLevel > 0.0) {
    float noise = rayleighNoise(vUv * u_resolution);
    sigma0 *= mix(1.0, noise, u_speckleLevel);
  }

  // Convert to logarithmic scale (dB)
  float dB = 10.0 * log(max(sigma0, 1e-5)) / log(10.0);
  float normalizedIntensity = clamp((dB - u_dbMin) / (u_dbMax - u_dbMin), 0.0, 1.0);

  // Amplute coloring
  vec3 sarColor = vec3(normalizedIntensity);

  gl_FragColor = vec4(sarColor, 1.0);
}
