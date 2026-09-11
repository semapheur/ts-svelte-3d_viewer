<script lang="ts">
  import { untrack } from "svelte";
  import GUI from "lil-gui";
  import type { SarImage, SarParams } from "../lib/sar_simulator/types";

  interface Props {
    params: SarParams;
    image: SarImage | null;
    busy?: boolean;
    error?: string | null;
  }

  let { params, image, busy = false, error = null }: Props = $props();

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

  function sarGui(container: HTMLDivElement) {
    let gui: GUI;

    untrack(() => {
      gui = new GUI({ container, title: "SAR Parameters" });

      const radarFolder = gui.addFolder("Radar");
      radarFolder
        .add(params, "antennaSize_m", 0.5, 20, 0.1)
        .name("Antenna size (m)");
      radarFolder
        .add(params, "chirpBandwidth_Hz", 10e6, 1e9, 1e6)
        .name("Chirp bandwidth (Hz)");
      radarFolder
        .add(params, "centerFrequency_Hz", 1e9, 40e9, 1e8)
        .name("Center frequency (Hz)");
      radarFolder
        .add(params, "pulseRepetitionFrequency_Hz", 100, 10000, 10)
        .name("PRF (Hz)");

      const polFolder = gui.addFolder("Polarization");
      polFolder.add(params.polarization, "tx", ["H", "V"]).name("Tx");
      polFolder.add(params.polarization, "rx", ["H", "V"]).name("Rx");

      const acquisition = gui.addFolder("Acquisition");
      acquisition.add(params, "mode", ["stripmap", "spotlight"]).name("Mode");
      acquisition
        .add(params, "platformSpeed_mps", 1, 500, 1)
        .name("Platform speed (m/s)");
      acquisition
        .add(params, "apertureDuration_s", 0.05, 20, 0.05)
        .name("Aperture duration (s)");

      const output = gui.addFolder("Output");
      output.add(params, "maxPulses", 8, 1024, 8).name("Max pulses");
      output.add(params, "imageSize", 64, 1024, 64).name("Image size (px)");
    });

    return () => gui.destroy();
  }
</script>

<div class="sar-viewer">
  <div class="gui" {@attach sarGui}></div>
  <canvas {@attach sarCanvas}></canvas>
</div>

<style>
  .sar-viewer {
    position: relative;
  }

  .gui {
    position: absolute;
  }

  canvas {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    aspect-ratio: 1 / 1;
  }
</style>
