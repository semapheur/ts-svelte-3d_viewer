<script lang="ts">
  import { ModelViewer } from "./lib/model_viewer.svelte";
  import { SarController } from "./lib/sar_simulator/controller.svelte";
  import ProgressBar from "./components/ProgressBar.svelte";
  import Spinner from "./components/Spinner.svelte";
  import Window from "./components/Window.svelte";
  import SarViewer from "./components/SarViewer.svelte";

  let resolutionScale = $state(1);
  let viewer = $state<ModelViewer | null>(null);
  let sar = $state<SarController | null>(null);
  let showSar = $state<boolean>(false);

  $effect(() => {
    if (sar) sar.enabled = showSar;
  });

  function threeAttachment(node: HTMLCanvasElement) {
    const _viewer = new ModelViewer(node);
    viewer = _viewer;
    let disposed = false;

    (async () => {
      await _viewer.init();
      if (disposed) return;

      sar = new SarController({
        enabled: showSar,
        camera: _viewer.camera,
        controls: _viewer.controls,
        scene: _viewer.scene,
        settleDelay_ms: 350,
        maxScatterers: 2500,
      });
    })();

    return () => {
      disposed = true;
      sar?.dispose();
      sar = null;

      viewer?.dispose();
      viewer = null;
    };
  }

  async function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length || !viewer) return;
    await viewer.loadModelFromFile(input.files[0]);

    sar?.runSimulation();
  }
</script>

<div class="container">
  <header class="header">
    <fieldset>
      <legend>Load Model</legend>
      <input type="file" accept=".glb" onchange={onFileChange} />
    </fieldset>
    <fieldset class="export">
      <legend>Export</legend>
      <div class="export-png">
        <input
          type="number"
          min="1"
          max="4"
          step="1"
          bind:value={resolutionScale}
        />
        <button onclick={() => viewer?.exportPng(resolutionScale)}>PNG</button>
      </div>
      <button onclick={() => viewer?.exportSvg()}>SVG</button>
    </fieldset>
    <button onclick={() => (showSar = !showSar)}>SAR</button>
  </header>

  {#if viewer}
    <ProgressBar
      value={viewer.progress}
      visible={viewer.loadingProgress}
      top="calc(100% - 0.5rem)"
      left="0"
      barWidth="100%"
      barHeight="0.5rem"
    />
    <Spinner
      visible={viewer.loadingProgress}
      size="1rem"
      top="calc(100% - 2rem)"
      left="0.5rem"
    />
  {/if}

  <canvas {@attach threeAttachment} class="viewer"></canvas>
  {#if showSar && sar}
    <Window bind:open={showSar} title="SAR image">
      <SarViewer
        params={sar.params}
        image={sar.image}
        busy={sar.busy}
        error={sar.error}
      />
    </Window>
  {/if}
</div>

<style>
  :global(:root) {
    --color-bg: #111;
    --color-bg-container: #222;
    --color-text: #eee;
    --color-border: #555;
    --color-border-hover: #777;
    --color-bg-button: #333;
    --color-bg-button-hover: #444;
    --color-bg-button-active: #555;
    --border-radius: 4px;
    --padding-button: 0.4rem 0.8rem;
  }

  :global(body) {
    background: var(--color-bg);
    color: var(--color-text);
  }

  :global(fieldset) {
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: 0.2rem;
  }

  :global(legend) {
    font-size: 0.8rem;
  }

  :global(button) {
    background: var(--color-bg-button);
    color: var(--color-text);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: var(--padding-button);
    cursor: pointer;
    transition:
      background 0.2s,
      border-color 0.2s;
  }

  :global(button:hover) {
    background: var(--color-bg-button-hover);
    border-color: var(--color-border-hover);
  }

  .header {
    display: flex;
    justify-content: start;
    align-items: center;
    padding: 0 0.2rem 0.2rem 0.2rem;
  }

  .container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    position: relative;
    background: var(--color-bg-container);
  }

  .viewer {
    flex-grow: 1;
    position: relative;
  }

  .export {
    display: flex;
    gap: 0.5rem;
  }

  .export-png {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);

    & input,
    button {
      border: none;
      border-radius: 0;
    }
  }

  input[type="file"] {
    cursor: pointer;
    background: var(--color-bg-button);
    border: 1px solid var(--color-border);
    border-radius: var(--border-radius);
    padding: 0.2rem 0.6rem;
    color: var(--color-text);
  }
</style>
