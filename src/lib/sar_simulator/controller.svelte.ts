import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/Addons.js";
import type { SarParams, SarImage } from "./types";
import type { SarWorkerRequest, SarWorkerResponse } from "./sar.worker";
import {
  buildSarPassGeometry,
  toTransferable as geometryToTransferable,
} from "./geometry";
import {
  sampleScneeScatterers,
  toTransferable as scatterersToTransferable,
} from "./scene_sampler";

export interface SarControllerOptions {
  enabled: boolean;
  camera: THREE.Camera;
  controls: OrbitControls;
  scene: THREE.Scene;
  settleDelay_ms?: number;
  maxScatterers?: number;
  excludeNames?: string[];
}

export class SarController {
  params = $state<SarParams>({
    antennaSize_m: 4,
    chirpBandwidth_Hz: 500e6,
    centerFrequency_Hz: 9e9,
    pulseRepetition_Hz: 1500,
    polarization: { tx: "V", rx: "V" },
    mode: "stripmap",
    platformSpeed_mps: 120,
    apertureDuration_s: 10.0,
    eccentricity: 0,
    maxPulses: 256,
    imageSize: 512,
  });

  #image = $state<SarImage | null>(null);
  #busy = $state<boolean>(false);
  #lastError = $state<string | null>(null);
  #enabled = $state<boolean>(false);

  #options: SarControllerOptions;
  #settleDelay_ms: number;
  #worker: Worker;
  #requestCounter = 0;
  #latestRequestId = -1;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #paramTimer: ReturnType<typeof setTimeout> | null = null;
  #onControlsChange = () => this.#scheduleSettle();
  #disposeEffect: (() => void) | null = null;

  constructor(options: SarControllerOptions) {
    this.#options = options;
    this.#enabled = options.enabled;
    this.#settleDelay_ms = options.settleDelay_ms ?? 350;

    if (options.maxScatterers !== undefined) {
      this.params.maxScatterers = options.maxScatterers;
    }

    this.#worker = new Worker(new URL("./sar.worker.ts", import.meta.url), {
      type: "module",
    });

    this.#worker.onmessage = (event: MessageEvent<SarWorkerResponse>) => {
      const message = event.data;
      if (message.requestId !== this.#latestRequestId) return;

      this.#busy = false;
      if (message.type === "result" && message.image) {
        this.#image = message.image;
        this.#lastError = null;
      } else if (message.type === "error") {
        this.#lastError = message.error ?? "Unknown SAR simulation error";
      }
    };

    options.controls.addEventListener("change", this.#onControlsChange);

    this.#disposeEffect = $effect.root(() => {
      $effect(() => {
        void this.params.antennaSize_m;
        void this.params.chirpBandwidth_Hz;
        void this.params.centerFrequency_Hz;
        void this.params.pulseRepetition_Hz;
        void this.params.polarization.tx;
        void this.params.polarization.rx;
        void this.params.mode;
        void this.params.platformSpeed_mps;
        void this.params.apertureDuration_s;
        void this.params.maxScatterers;
        void this.params.eccentricity;

        if (!this.#enabled) return;

        if (this.#paramTimer) clearTimeout(this.#paramTimer);
        this.#paramTimer = setTimeout(() => this.runSimulation(), 150);
      });
    });

    if (this.#enabled) this.runSimulation();
  }

  get image() {
    return this.#image;
  }

  get busy() {
    return this.#busy;
  }

  get error() {
    return this.#lastError;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(v: boolean) {
    if (v === this.#enabled) return;
    this.#enabled = v;

    if (!v) {
      if (this.#settleTimer) {
        clearTimeout(this.#settleTimer);
        this.#settleTimer = null;
      }

      if (this.#paramTimer) {
        clearTimeout(this.#paramTimer);
        this.#paramTimer = null;
      }
      this.#busy;
    } else {
      this.runSimulation();
    }
  }

  #scheduleSettle() {
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      this.runSimulation();
    }, this.#settleDelay_ms);
  }

  runSimulation() {
    if (!this.#enabled) return;

    const target = this.#options.controls.target.clone();
    const geometry = buildSarPassGeometry(this.#options.camera, target, {
      mode: this.params.mode,
      platformSpeed: this.params.platformSpeed_mps,
      apertureDuration: this.params.apertureDuration_s,
      pulseRepitionFrequency: this.params.pulseRepetition_Hz,
      centerFrequency: this.params.centerFrequency_Hz,
      maxPulses: this.params.maxPulses,
      eccentricity: this.params.eccentricity,
    });

    const exclude = new Set(
      this.#options.excludeNames ?? ["grid", "gizmo", "spotlight-helper"],
    );
    const scatterers = sampleScneeScatterers(this.#options.scene, {
      maxScatterers: this.params.maxScatterers ?? 2500,
      excludeNames: exclude,
    });

    const requestId = ++this.#requestCounter;
    this.#latestRequestId = requestId;
    this.#busy = true;
    this.#lastError = null;

    const request: SarWorkerRequest = {
      type: "simulate",
      requestId,
      params: $state.snapshot(this.params),
      geometry: geometryToTransferable(geometry),
      scatterers: scatterersToTransferable(scatterers),
    };
    this.#worker.postMessage(request);
  }

  dispose() {
    this.#options.controls.removeEventListener(
      "change",
      this.#onControlsChange,
    );
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    if (this.#paramTimer) clearTimeout(this.#paramTimer);
    this.#disposeEffect?.();
    this.#worker.terminate();
  }
}
