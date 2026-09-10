<script lang="ts">
  import type { SarImage } from "../lib/sar_simulator/types";

  interface Props {
    image: SarImage | null;
    busy?: boolean;
    error?: string | null;
  }

  let { image, busy = false, error = null }: Props = $props();

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
</script>

<div class="sar-viewer">
  <canvas {@attach sarCanvas}></canvas>
</div>

<style>
  canvas {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    aspect-ratio: 1 / 1;
  }
</style>
