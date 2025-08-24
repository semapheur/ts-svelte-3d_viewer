<script lang="ts">
import { fade } from "svelte/transition"

interface Props {
  value?: number
  visible?: boolean
  top?: string
  left?: string
  barWidth?: string
  barHeight?: string
}

let {
  value = 0,
  visible = false,
  top = "0px",
  left = "0px",
  barWidth = "100%",
  barHeight = "0.5rem",
}: Props = $props()

let fill = $state(0)

$effect(() => {
  if (visible) {
    fill = value
  } else {
    fill = 0
  }
})
</script>

{#if visible}
  <div 
    class="progress-container"
    transition:fade 
    style="
      top: {top};
      left: {left};
      width: {barWidth};
      height: {barHeight};"
  >
    <div class="progress-bar" style="width: {fill}%;"></div>
  </div>
{/if}

<style>
  .progress-container {
    position: absolute;
    background: rgba(255, 255, 255, 0.1);
    z-index: 99;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: #4cafef;
    transition: width 0.3s ease; /* smooth fill */
    will-change: width;
  }
</style>