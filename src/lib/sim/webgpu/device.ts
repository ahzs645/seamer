/// <reference types="@webgpu/types" />

export function isWebGPUAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export async function requestClothDevice(): Promise<GPUDevice> {
  if (!isWebGPUAvailable()) {
    throw new Error('WebGPU is not available in this browser. The cloth simulation requires WebGPU (Chrome, Edge, or a recent Safari).');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No suitable WebGPU adapter found.');
  // The body-collision shader needs 9 storage buffers when the cloth-normal filter is on; the WebGPU
  // default per-stage limit is 8. Request up to 10 (most adapters expose ≥10) — capped at what this
  // adapter actually supports, so requestDevice never rejects. The engine checks the granted limit
  // and only enables the filter when ≥9 (otherwise it uses the 8-buffer collision shader).
  const want = 10;
  const have = adapter.limits.maxStorageBuffersPerShaderStage;
  const requiredLimits = have >= want ? { maxStorageBuffersPerShaderStage: want } : undefined;
  return adapter.requestDevice(requiredLimits ? { requiredLimits } : undefined);
}
