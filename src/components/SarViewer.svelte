<script lang="ts">
  import { untrack } from "svelte";
  import GUI from "lil-gui";
  import type { SarImage, SarParams } from "../lib/sar_simulator/types";
  import {
    SAR_TOOLTIPS,
    createTooltipHost,
    attachTooltip,
    type TooltipState,
  } from "../lib/sar_simulator/tooltips";

  interface Props {
    params: SarParams;
    image: SarImage | null;
    busy?: boolean;
    error?: string | null;
  }

  let { params, image, busy = false, error = null }: Props = $props();

  let showStats = $state<boolean>(true);

  function formatMeters(meters: number) {
    if (meters < 1) {
      return `${(meters * 100).toFixed(1)} cm`;
    }

    return `${meters.toFixed(2)} m`;
  }

  function formatDegrees(radians: number) {
    return `${((radians * 180) / Math.PI).toFixed(1)}°`;
  }

  function draw(canvas: HTMLCanvasElement, image: SarImage) {
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return;

    const imageData = context.createImageData(image.width, image.height);
    const range = Math.max(1e-6, image.max_dB - image.min_dB);

    for (let i = 0; i < image.data.length; i++) {
      const norm = (image.data[i] - image.min_dB) / range;

      const v = Math.round(255 * Math.pow(Math.max(0, Math.min(1, norm)), 0.7));
      const o = i * 4;
      imageData.data[o] = v;
      imageData.data[o + 1] = v;
      imageData.data[o + 2] = v;
      imageData.data[o + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
  }

  function sarCanvas(canvas: HTMLCanvasElement) {
    if (image) draw(canvas, image);

    //return () => {};
  }

  function upperBandwith_MHz(centerfrequency_Hz: number) {
    return (2 * centerfrequency_Hz) / 1e6;
  }

  function sarGui(container: HTMLDivElement) {
    let gui: GUI;
    let bandwidthController: any;
    const uiState = {
      centerFrequency_GHz: 0,
      chirpBandwidth_MHz: 0,
      pulseRepetition_kHz: 0,
    };

    const tooltipHost = createTooltipHost();
    const tooltipState: TooltipState = { enabled: true };
    const tooltipCleanups: (() => void)[] = [];

    function withTooltip(controller: any, key: string) {
      const markdown = SAR_TOOLTIPS[key];
      if (markdown) {
        tooltipCleanups.push(
          attachTooltip(
            controller.domElement,
            markdown,
            tooltipHost,
            tooltipState,
          ),
        );
      }

      return controller;
    }
    untrack(() => {
      gui = new GUI({ container, title: "SAR Parameters" });

      gui
        .add(tooltipState, "enabled")
        .name("Tooltips")
        .onChange((v: boolean) => {
          if (!v) tooltipHost.hide();
        });

      gui
        .add({ showStats }, "showStats")
        .name("Metadata")
        .onChange((v: boolean) => {
          showStats = v;
        });

      const radarFolder = gui.addFolder("Radar");

      uiState.centerFrequency_GHz = params.centerFrequency_Hz / 1e9;
      uiState.chirpBandwidth_MHz = params.chirpBandwidth_Hz / 1e6;
      uiState.pulseRepetition_kHz = params.pulseRepetition_Hz / 1e3;

      withTooltip(
        radarFolder
          .add(params, "antennaSize_m", 0.5, 20, 0.1)
          .name("Antenna size (m)"),
        "antennaSize_m",
      );

      withTooltip(
        radarFolder
          .add(uiState, "centerFrequency_GHz", 1, 18, 0.01)
          .name("Center frequency (GHz)")
          .onChange((ghz: number) => {
            params.centerFrequency_Hz = ghz * 1e9;

            const maxMHz = upperBandwith_MHz(params.centerFrequency_Hz);
            bandwidthController.max(maxMHz);
            if (uiState.chirpBandwidth_MHz > maxMHz) {
              uiState.chirpBandwidth_MHz = maxMHz;
              params.chirpBandwidth_Hz = maxMHz * 1e6;
              bandwidthController.updateDisplay();
            }
          }),
        "centerFrequency_GHz",
      );

      bandwidthController = withTooltip(
        radarFolder
          .add(
            uiState,
            "chirpBandwidth_MHz",
            0,
            upperBandwith_MHz(params.centerFrequency_Hz),
            100,
          )
          .name("Chirp bandwidth (MHz)")
          .onChange((mhz: number) => {
            params.chirpBandwidth_Hz = mhz * 1e6;
          }),
        "chirpBandwidth_MHz",
      );

      withTooltip(
        radarFolder
          .add(uiState, "pulseRepetition_kHz", 1, 20, 0.1)
          .name("PRF (kHz)")
          .onChange((khz: number) => {
            params.pulseRepetition_Hz = khz * 1e3;
          }),
        "pulseRepetition_kHz",
      );

      const polFolder = gui.addFolder("Polarization");

      withTooltip(
        polFolder.add(params.polarization, "tx", ["H", "V"]).name("Tx"),
        "polarizationTx",
      );
      withTooltip(
        polFolder.add(params.polarization, "rx", ["H", "V"]).name("Rx"),
        "polarizationRx",
      );

      const acquisition = gui.addFolder("Acquisition");
      withTooltip(
        acquisition.add(params, "mode", ["stripmap", "spotlight"]).name("Mode"),
        "mode",
      );
      withTooltip(
        acquisition
          .add(params, "platformSpeed_mps", 1, 500, 1)
          .name("Platform speed (m/s)"),
        "platformSpeed_mps",
      );
      withTooltip(
        acquisition
          .add(params, "apertureDuration_s", 0.05, 20, 0.05)
          .name("Aperture duration (s)"),
        "apertureDuration_s",
      );

      const outputFolder = gui.addFolder("Output");
      withTooltip(
        outputFolder.add(params, "maxPulses", 8, 1024, 8).name("Max pulses"),
        "maxPulses",
      );
      withTooltip(
        outputFolder
          .add(params, "maxScatterers", 100, 10000, 100)
          .name("Max scatterers"),
        "maxScatterers",
      );
      withTooltip(
        outputFolder
          .add(params, "imageSize", 64, 1024, 64)
          .name("Image size (px)"),
        "imageSize",
      );
    });

    return () => gui.destroy();
  }
</script>

<div class="sar-viewer">
  <div class="gui" {@attach sarGui}></div>
  <canvas {@attach sarCanvas}></canvas>
  {#if showStats && image}
    <div class="stats">
      <div class="stats-row">
        <span>Slant range:</span><span
          >{formatMeters(image.stats.slantRange_m)}</span
        >
      </div>
      <div class="stats-row">
        <span>Azimuth angle:</span><span
          >{formatDegrees(image.stats.azimuthAngle_rad)}</span
        >
      </div>
      <div class="stats-row">
        <span>Look angle:</span><span
          >{formatDegrees(image.stats.lookAngle_rad)}</span
        >
      </div>
      <div class="stats-row">
        <span>Range resolution:</span><span
          >{formatMeters(image.stats.rangeResolution_m)}</span
        >
      </div>
      <div class="stats-row">
        <span>Azimuth resolution:</span><span
          >{formatMeters(image.stats.azimuthResolution_m)}</span
        >
      </div>
    </div>
  {/if}
</div>

<style>
  .sar-viewer {
    position: relative;
  }

  .gui {
    position: absolute;
  }

  .stats {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: grid;
    grid-template-columns: max-content max-content;
    column-gap: 1rem;
    color: oklch(var(--color-text));
    text-shadow: var(--text-shadow);
  }

  .stats-row {
    display: contents;
  }

  canvas {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    aspect-ratio: 1 / 1;
  }

  :global(.sar-tooltip) {
    display: none;
    position: fixed;
    z-index: 1;
    max-width: 20vw;
    padding: 0 0.5rem;
    background: oklch(var(--color-primary) / 0.5);
    border-radius: 0.25rem;
    backdrop-filter: blur(5px);
    font-size: 0.75rem;
    pointer-events: none;
  }
</style>
