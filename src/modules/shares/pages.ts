import type { RequestHandler, Response, Router } from 'express';
import type { AppDeps } from '../../app.ts';
import { ApiError } from '../../http/errors.ts';
import { renderMissingPage, renderSharePage, SHARE_SCRIPT } from './page.ts';
import { getShared } from './service.ts';

/**
 * The share link itself (GET /s/{token}): an HTML page, outside the JSON API
 * and its OpenAPI document. nginx passes every path to the API and Cloudflare
 * caches neither (no cacheable extension, and `no-store`); the script has a
 * .js extension, so Cloudflare may cache it for its max-age.
 */
export function mountSharePages(router: Router, deps: AppDeps, limiter: RequestHandler) {
  const page = (res: Response, status: number, html: string) => {
    res.status(status).set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).type('html').send(html);
  };

  router.get('/s/share.js', limiter, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').type('application/javascript').send(SHARE_SCRIPT);
  });

  router.get('/s/:token', limiter, async (req, res) => {
    const token = String(req.params.token);
    try {
      page(res, 200, renderSharePage(await getShared(deps, token), token));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'share_not_found') return page(res, 404, renderMissingPage());
      throw err;
    }
  });
}
