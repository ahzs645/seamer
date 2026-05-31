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
  return adapter.requestDevice();
}
