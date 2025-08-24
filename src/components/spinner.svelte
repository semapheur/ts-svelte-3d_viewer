<script lang="ts">
export let visible = false
export let size = "2rem"
export let color = "#4cafef"
export let top = "0px"
export let left = "0px"
</script>

{#if visible}
<div class="overlay">
  <div class="spinner" style="--size:{size}; --color:{color}; top:{top}; left:{left}"></div>
</div>
{/if}

<style>
  .spinner {
    border: 4px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--color);
    border-radius: 50%;
    width: var(--size);
    height: var(--size);
    position: absolute;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>