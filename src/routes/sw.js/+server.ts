import { dev } from '$app/environment';
import { readFileSync } from 'fs';
import { join } from 'path';

const swContent = readFileSync(join(process.cwd(), 'static/service-worker.js'), 'utf-8');

export async function GET() {
  return new Response(swContent, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': dev ? 'no-cache' : 'max-age=0, s-maxage=86400'
    }
  });
}
