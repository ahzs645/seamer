import { test, expect, type Page } from '@playwright/test';

// Genuine click-through coverage for the Import → Samples dropdown. Each sample is fetched and
// parsed by the real app code; we assert the resulting toast + that the 2D canvas has geometry.

async function openStudio(page: Page) {
	await page.goto('/studio');
	// dismiss the one-time welcome modal if it appears
	const getStarted = page.getByRole('button', { name: 'Get started' });
	if (await getStarted.isVisible().catch(() => false)) await getStarted.click();
	// wait for the studio header to be ready
	await expect(page.getByText('Pattern Studio')).toBeVisible();
}

async function importSample(page: Page, label: string) {
	// open the Import dropdown (the header trigger labelled "Import")
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('button', { name: label }).click();
}

test.describe('Import samples', () => {
	test('studio loads and pattern name input is present', async ({ page }) => {
		await openStudio(page);
		await expect(page.getByPlaceholder('Pattern name...')).toBeVisible();
	});

	const samples = [
		{ label: 'Pocket (curved, SVG)', name: 'pocket-curved' },
		{ label: 'Two pieces (SVG)', name: 'two-pieces' },
		{ label: 'Rectangle (DXF)', name: 'rect-piece' },
		{ label: 'Curved hem (DXF bulge)', name: 'curved-hem' }
	];

	for (const s of samples) {
		test(`imports ${s.label}`, async ({ page }) => {
			await openStudio(page);
			await importSample(page, s.label);

			// success toast confirms the import path ran end-to-end
			await expect(page.getByText(`Imported "${s.name}"`)).toBeVisible();
			// the pattern-name field reflects the imported file name
			await expect(page.getByplaceholder('Pattern name...')).toHaveValue(s.name);
			// a canvas exists and has non-zero size (2D view rendered)
			const canvas = page.locator('canvas').first();
			await expect(canvas).toBeVisible();
			const box = await canvas.boundingBox();
			expect(box && box.width > 0 && box.height > 0).toBeTruthy();
		});
	}

	test('object browser lists imported pieces', async ({ page }) => {
		await openStudio(page);
		await importSample(page, 'Two pieces (SVG)');
		await expect(page.getByText('Imported "two-pieces"')).toBeVisible();

		// open the Object browser via its toolbar toggle (title="Toggle object browser")
		await page.locator('button[title="Toggle object browser"]').click();
		await expect(page.getByText('Object browser')).toBeVisible();
		// the Pieces group header should report 2 pieces
		await expect(page.getByText(/^Pieces \(2\)$/)).toBeVisible();
	});
});
