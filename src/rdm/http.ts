/** Headers that could identify or authenticate us; never logged or persisted. */
const SENSITIVE_HEADER = /key|auth|token|cookie|secret/i;

export interface RdmResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function safeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!SENSITIVE_HEADER.test(name)) out[name] = value;
  });
  return out;
}

/** GET a Rail Data Marketplace endpoint with the product's consumer key in the configured header. */
export async function rdmGet(url: string, auth: { header: string; key: string }, accept = 'application/json'): Promise<RdmResponse> {
  const res = await fetch(url, {
    headers: { [auth.header]: auth.key, Accept: accept },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, headers: safeHeaders(res.headers), body: await res.text() };
}
