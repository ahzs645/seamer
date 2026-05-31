import { chromium, type FullConfig } from '@playwright/test';

// Warm the dev server before the suite: the first hit to /studio triggers Vite's on-demand compile
// of three.js + the whole studio graph, which can exceed a test's timeout. Pre-compiling here keeps
// the first real test from racing that cold start.
export default async function globalSetup(config: FullConfig) {
	const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:5173';
	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.goto(`${baseURL}/studio`, { waitUntil: 'load', timeout: 120_000 });
		// give on-demand chunks a moment to finish compiling/executing
		await page.waitForSelector('input[placeholder="Pattern name..."]', { timeout: 60_000 }).catch(() => {});
	} finally {
		await browser.close();
	}
}
