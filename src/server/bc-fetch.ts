import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

/** TLS verification stays enabled; this CA applies only to the configured origin. */
export function bcFetch(origin: string, caFile: string): typeof fetch {
  const allowed = new URL(origin);
  if (allowed.protocol !== 'https:' || allowed.username || allowed.password)
    throw new Error(
      'BC-250 requires an HTTPS URL without embedded credentials.',
    );
  const ca = readFileSync(caFile);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== allowed.origin) throw new Error('BC-250 origin denied.');
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('accept-encoding', 'identity');
    const body =
      init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (body != null && typeof body !== 'string')
      throw new Error('BC-250 requests require a text body.');
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method:
            init?.method ?? (input instanceof Request ? input.method : 'GET'),
          headers: Object.fromEntries(headers),
          ca,
          signal:
            init?.signal ??
            (input instanceof Request ? input.signal : undefined),
        },
        (res) => {
          const resultHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              resultHeaders.set(
                key,
                Array.isArray(value) ? value.join(', ') : value,
              );
          // No redirect following: the caller rejects any non-success status.
          resolve(
            new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, {
              status: res.statusCode ?? 502,
              headers: resultHeaders,
            }),
          );
        },
      );
      req.once('error', reject);
      req.end(body);
    });
  };
}
