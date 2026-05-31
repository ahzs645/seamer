import { test, expect, type Page } from '@playwright/test';

// Verifies the reported fix: once an edge is selected, the Properties panel exposes an Edge editor
// where length + angle are editable, and nudging the angle changes the value (a real geometry edit).
// This matches the original studio, which edits edges via length/angle.

// Pre-dismiss the one-time welcome modal so its overlay never intercepts clicks.
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('seamscape.welcomeSeen', '1'));
});

async function openStudio(page: Page) {
	await page.goto('/studio');
	await expect(page.getByText('Pattern Studio')).toBeVisible();
}

async function importRectangle(page: Page) {
	await page.locator('div[role="button"]', { hasText: /^Import$/ }).click();
	await page.getByRole('button', { name: 'Rectangle (DXF)' }).click();
	await expect(page.getByText('Imported "rect-piece"')).toBeVisible();
}

test('selecting a piece then an edge lets you edit the edge angle', async ({ page }) => {
	await openStudio(page);
	await importRectangle(page);

	// select the piece via the Object browser (deterministic), then close the floating panel
	await page.locator('button[title="Toggle object browser"]').click();
	await page.getByText('Piece 1', { exact: true }).click();
	await page.locator('button[title="Toggle object browser"]').click();

	// Properties panel now shows the piece; its Seam boundary list is open by default
	await expect(page.locator('span', { hasText: /^Properties for Piece/ })).toBeVisible();
	await expect(page.getByText('Seam boundary')).toBeVisible();

	// pick the first boundary edge → selects its path (piece stays selected)
	await page.locator('button.font-bold').filter({ hasText: /^Line/ }).first().click();

	// Edge editor appears; header flips to "for Edge"; Length + Angle controls present
	await expect(page.locator('span', { hasText: /^Properties for Edge/ })).toBeVisible();
	const angle = page.locator('label', { hasText: 'Angle (°)' }).locator('input');
	await expect(angle).toBeVisible();
	const before = await angle.inputValue();

	// nudge +1° → the angle value changes (geometry edit re-derived)
	await page.getByTitle('Rotate +1°').click();
	await expect.poll(async () => await angle.inputValue()).not.toBe(before);
});
