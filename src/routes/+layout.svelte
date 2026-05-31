<script lang="ts">
  import '../app.css';
  import AppHeader from '$lib/components/AppHeader.svelte';

  let { children } = $props();
</script>

<div class="relative w-full min-h-screen flex flex-col max-w-screen-2xl mx-auto bg-base-100">
  <AppHeader />
  <main class="flex-1">
    {@render children()}
  </main>
  <footer class="footer footer-center p-10 bg-base-200 text-base-content rounded">
    <nav class="grid grid-flow-col gap-4">
      <a href="/about" class="link link-hover">About</a>
      <a href="/software" class="link link-hover">Software</a>
      <a href="/docs" class="link link-hover">Docs</a>
      <a href="/support-seamer" class="link link-hover">Support</a>
    </nav>
    <aside>
      <p>&copy; {new Date().getFullYear()} Seamer. All rights reserved.</p>
    </aside>
  </footer>
</div>
