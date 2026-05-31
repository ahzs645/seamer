export const prerender = false;
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Pattern, PatternSummary } from '$lib/types/pattern';

const patterns = new Map<string, Pattern>();

export const GET: RequestHandler = async () => {
  const list: PatternSummary[] = Array.from(patterns.values()).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    is3d: p.enable3d,
    thumbnailUrl: null,
    updatedAt: new Date().toISOString(),
    ownerUserId: 'system',
    organizationId: null,
    organization: null,
    owner: {
      id: 'system',
      firstName: 'System',
      lastName: null,
      email: '',
      image: null
    }
  }));
  return json(list);
};

export const POST: RequestHandler = async ({ request }) => {
  const pattern: Pattern = await request.json();
  patterns.set(pattern.id, pattern);
  return json(pattern, { status: 201 });
};