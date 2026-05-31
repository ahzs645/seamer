import { defineConfig, devices } from '@playwright/test';

// E2E config: boots the dev server, runs Chromium against the studio.
export default defineConfig({
	testDir: './e2e',
	testMatch: '**/*.spec.ts',
	timeout: 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1, // single dev server on a fixed port — parallel workers race on it
	retries: 1, // tolerate first-load flakiness (cold dev-server boot)
	reporter: [['list']],
	use: {
		baseURL: 'http://localhost:5173',
		trace: 'on-first-retry',
		// WebGL/WebGPU aren't needed for these DOM-level import tests
		launchOptions: { args: ['--enable-unsafe-swiftshader'] }
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'npm run dev -- --port 5173',
		url: 'http://localhost:5173',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	}
});
