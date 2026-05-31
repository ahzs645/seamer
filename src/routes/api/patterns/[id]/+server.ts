export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Pattern } from '$lib/types/pattern';

const patterns = new Map<string, Pattern>();

export const GET: RequestHandler = async ({ params }) => {
  const pattern = patterns.get(params.id);
  if (!pattern) return json({ error: 'Not found' }, { status: 404 });
  return json(pattern);
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const pattern: Pattern = await request.json();
  patterns.set(params.id, pattern);
  return json(pattern);
};

export const DELETE: RequestHandler = async ({ params }) => {
  patterns.delete(params.id);
  return json({ success: true });
};