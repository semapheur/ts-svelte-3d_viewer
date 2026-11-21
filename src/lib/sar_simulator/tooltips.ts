import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";

marked.use(markedKatex({ throwOnError: false }));

export const SAR_TOOLTIPS: Record<string, string> = {
  antennaSize_m: `
**Antenna size** ($L$) sets the real-aperture beamwidth ($\\theta$):

$$\\theta \\approx \\lambda / L$$

where $\\lambda$ denotes wavelength. In *stripmap* mode this directly sets azimuth resolution ($\\rho_{az}$), independent of range:

$$\\rho_{az} \\approx L / 2$$

A bigger antenna narrows the beam, which *worsens* stripmap azimuth resolution (smaller footprint swept per unit time) — this is the classic real-aperture trade-off that the synthetic aperture is designed to get around in spotlight mode.
`,
  centerFrequency_GHz: `
**Center frequency** ($f_c$) sets the wavelength ($\\lambda$):

$$\\lambda = c / f_c$$

where $c$ is the speed of light. Higher frequency → shorter $\\lambda$ → narrower real-aperture beamwidth $\\theta \\approx \\lambda/L$ for the same antenna, and finer *spotlight* azimuth resolution, since $\\lambda$ appears directly in that formula. It does not affect range resolution, which is set purely by bandwidth.
`,
  chirpBandwidth_MHz: `
**Chirp bandwidth (B)** sets slant-range resolution ($\\rho_r$) directly:

$$\\rho_r = \\dfrac{c}{2B}$$

Doubling the bandwidth halves the range resolution (finer detail). This is independent of center frequency, platform speed, or aperture time.
`,
  pulseRepetition_kHz: `
**Pulse repetition frequency (PRF)** sets the pulse spacing in slow time. It must satisfy a Nyquist-style condition on the Doppler bandwidth to avoid azimuth ambiguities:

$$\\text{PRF} \\gtrsim B_{doppler}$$

PRF sets how faithfully the true Doppler (azimuth phase) history is sampled, which is what azimuth compression actually relies on.
`,
  platformSpeed_mps: `
**Platform speed (v)**, together with aperture duration ($T$), sets the synthetic aperture length ($L_{sa}$):

$$L_{sa} = v \\cdot T$$

which (in spotlight mode) is the length that determines azimuth resolution.
`,
  apertureDuration_s: `
**Aperture duration** ($T$) sets how long the platform coherently integrates returns. Combined with speed it gives the synthetic aperture length $L_{sa} = vT$, which sets *spotlight* azimuth resolution ($\\rho_{ax}$$):

$$\\rho_{az} \\approx \\dfrac{\\lambda R}{2 L_{sa}}$$

Longer aperture time → longer $L_{sa}$ → finer azimuth resolution. This is the mechanism that lets spotlight mode beat the fixed $L/2$ limit of stripmap.
`,
  eccentricity: `
Blends the flight path between *fully circular* (0, the default) — an orbit around the scene center — and *fully linear* (1) — a straight line through the camera's current position, along the same tangent direction the orbit has there.`,
  mode: `
**Stripmap** keeps the antenna boresight fixed (broadside), so a target is only illuminated for as long as the real-aperture beam sweeps past it. Azimuth resolution is capped at $\\rho_{az} \\approx L/2$, independent of range or aperture duration.

**Spotlight** continuously re-steers the beam at the scene center, keeping it illuminated for the *entire* aperture duration $T$. This lets the synthetic aperture length $L_{sa} = vT$ grow arbitrarily (within antenna steering limits), giving azimuth resolution

$$\\rho_{az} \\approx \\dfrac{\\lambda R}{2 L_{sa}}$$

which is finer than stripmap, at the cost of a smaller imaged patch.
`,
  maxPulses: `
Caps how many pulses are actually simulated (subsampling slow time within the aperture). This adjusts simulation fidelity and is not a physical quantity. As long as it stays high enough to satisfy the PRF/aperture-duration Nyquist sampling, the achievable resolution is unaffected; too few pulses will just under-sample the true Doppler history and degrade focusing.
`,
  imageSize: `
Sets the **output pixel grid**, i.e. how densely the processed SAR image is sampled for display. It does not change the physical resolution set by bandwidth ($\\rho_r$) and aperture geometry ($\\rho_{az}$); increasing it past that limit only produces more pixels per resolution cell (oversampling), not more real detail.
`,
  maxScatterers: `
Caps how many point scatterers are sampled from the scene meshes (stride-sampled if the model has more vertices than this). This adjusts simulation fidelity and is not a physical quantity. Too few scatterers under-represents the surface, producing a sparse or speckled image that misses fine geometric detail the true resolution could otherwise resolve; more scatterers costs roughly linear extra compute per pulse.
  `,
  polarizationTx: `
Sets transmission polarization between *horizontal* (H) or *vertical*. Co-polarization (HH/VV) favorises single-bounce (VV) and double-bounce (HH) backscattering, while cross-polarization (HV/VH) favorises diffusive backscattering.
`,
  polarizationRx: `
Sets reception polarization between *horizontal* (H) or *vertical*. Co-polarization (HH/VV) favorises single-bounce (VV) and double-bounce (HH) backscattering, while cross-polarization (HV/VH) favorises diffusive backscattering.
`,
};

export function renderTooltipMarkdown(markdown: string) {
  return marked.parse(markdown) as string;
}

export interface TooltipState {
  enabled: boolean;
}

export interface TooltipHost {
  show(html: string, clientX: number, clientY: number): void;
  move(clientX: number, clientY: number): void;
  hide(): void;
  destroy(): void;
}

function position(div: HTMLDivElement, clientX: number, clientY: number) {
  const pad = 14;
  const rect = div.getBoundingClientRect();
  let left = clientX + pad;
  let top = clientY + pad;
  if (left + rect.width > window.innerWidth) left = clientX - rect.width - pad;
  if (top + rect.height > window.innerHeight) top = clientX - rect.height - pad;
  div.style.left = `${Math.max(4, left)}px`;
  div.style.top = `${Math.max(4, top)}px`;
}

export function createTooltipHost(): TooltipHost {
  const el = document.createElement("div");
  el.className = "sar-tooltip";
  document.body.appendChild(el);

  return {
    show(html, clientX, clientY) {
      el.innerHTML = html;
      el.style.display = "block";
      position(el, clientX, clientY);
    },
    move(clientX, clientY) {
      if (el.style.display !== "none") position(el, clientX, clientY);
    },
    hide() {
      el.style.display = "none";
    },
    destroy() {
      el.remove();
    },
  };
}

export function attachTooltip(
  target: HTMLElement,
  markdown: string,
  host: TooltipHost,
  state: TooltipState,
): () => void {
  const html = renderTooltipMarkdown(markdown);

  const onEnter = (e: MouseEvent) => {
    if (!state.enabled) return;
    host.show(html, e.clientX, e.clientY);
  };
  const onMove = (e: MouseEvent) => {
    if (!state.enabled) return;
    host.move(e.clientX, e.clientY);
  };
  const onLeave = () => host.hide();

  target.addEventListener("mouseenter", onEnter);
  target.addEventListener("mousemove", onMove);
  target.addEventListener("mouseleave", onLeave);

  return () => {
    target.removeEventListener("mouseenter", onEnter);
    target.removeEventListener("mousemove", onMove);
    target.removeEventListener("mouseleave", onLeave);
  };
}
