<script lang="ts">
  interface Props {
    visible: boolean;
    size: string;
    color?: string;
    top: string;
    left: string;
  }

  let {
    visible = false,
    size = "2rem",
    color = "#4cafef",
    top = "0px",
    left = "0px",
  }: Props = $props();
</script>

{#if visible}
  <div
    class="spinner"
    style="--size:{size}; --color:{color}; top:{top}; left:{left}"
  ></div>
{/if}

<style>
  .spinner {
    border: 4px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--color);
    border-radius: 50%;
    width: var(--size);
    height: var(--size);
    position: absolute;
    z-index: 99;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
