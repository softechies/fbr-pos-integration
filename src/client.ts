import { validateImsInvoice, InvoiceValidationError } from './build.js';
import type { FiscalResult, GatewayFault, ImsInvoice } from './types.js';

export type Environment = 'sandbox' | 'production';

export interface FbrClientOptions {
  /**
   * cloud: your server posts to FBR over HTTPS with a Bearer token.
   * local: the FBR Fiscal Component (Windows service) on the POS PC, http://localhost:8524.
   */
  mode: 'cloud' | 'local';
  /** Cloud only. Default sandbox. */
  environment?: Environment;
  /** Cloud only. Bearer token for this POS registration. Keep it on the server, encrypted at rest. */
  token?: string;
  /** Override the endpoint (proxy, different port for the local component). */
  url?: string;
  /** Default 30 seconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const URLS = {
  sandbox: 'https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData',
  production: 'https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData',
  local: 'http://localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel',
  localHealth: 'http://localhost:8524/api/IMSFiscal/Get',
};

/** The shared token FBR publishes for the sandbox. Use it with your own test POS ID. */
export const SANDBOX_TOKEN = '1298b5eb-b252-3d97-8622-a4a69d5bf818';

const FAULT_HINTS: Record<string, string> = {
  '900901': 'Token not recognised: it has a typo, expired or was revoked. Copy it again or ask FBR to reissue it.',
  '900902': 'No token was sent. Pass the Bearer token for this POS registration.',
  '900908': 'The token is valid but not for this API or environment. Use the IMS token that belongs to this POS (production tokens only work on production).',
  '900910': 'The token lacks the scope for this API. Regenerate it for IMS.',
};

/** Connection errors that mean the request never reached FBR, so resending is safe. */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class FbrImsClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FbrClientOptions) {
    if (options.mode === 'cloud' && !options.token) {
      throw new Error('Cloud mode needs a token. For the sandbox use SANDBOX_TOKEN with your own test POS ID.');
    }
    this.url = options.url ?? (options.mode === 'local' ? URLS.local : URLS[options.environment ?? 'sandbox']);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  get endpoint(): string {
    return this.url;
  }

  /**
   * Sends one bill. Never throws for FBR's answer: every outcome comes back as a FiscalResult so you
   * can store it on the bill. Throws only if the invoice itself is invalid (nothing is sent then).
   *
   * Call this after the bill is committed in your database, outside the transaction.
   */
  async post(invoice: ImsInvoice): Promise<FiscalResult> {
    const issues = validateImsInvoice(invoice);
    if (issues.length) throw new InvoiceValidationError(issues);

    const payload = JSON.stringify(invoice);
    const sent = await this.send(payload);
    if ('error' in sent) return { ...sent.error, payload };

    const { response, text, json } = sent;
    const body = json as Record<string, unknown> | undefined;

    // FBR's API gateway rejects bad tokens before IMS sees the bill.
    const fault = readFault(body);
    if (fault) {
      return { status: 'rejected', message: fault.message, fault, httpStatus: response.status, payload, raw: body };
    }

    if (response.status >= 500) {
      return { status: 'unknown', message: `FBR returned HTTP ${response.status}. The bill may or may not be filed; check before resending.`, httpStatus: response.status, payload, raw: json ?? text };
    }

    if (!body || typeof body !== 'object') {
      // An HTML error page from a proxy or gateway: we can't tell what happened.
      return {
        status: response.ok ? 'unknown' : 'rejected',
        message: `Expected JSON from FBR, got: ${text.slice(0, 500)}`,
        httpStatus: response.status,
        payload,
        raw: text,
      };
    }

    const code = body.Code === undefined || body.Code === null ? undefined : String(body.Code);
    const invoiceNumber = String(body.InvoiceNumber ?? body.FBRInvoiceNumber ?? '').trim();
    const message = String(body.Response ?? body.Message ?? '');
    const accepted = response.ok && code === '100' && invoiceNumber !== '' && !/not available/i.test(invoiceNumber);

    return {
      status: accepted ? 'fiscalized' : 'rejected',
      ...(accepted ? { invoiceNumber } : {}),
      ...(code !== undefined ? { code } : {}),
      message: message || (accepted ? 'Fiscal Invoice Number generated' : `FBR did not accept the bill (code ${code ?? 'none'})`),
      ...(body.Errors !== undefined && body.Errors !== null ? { errors: body.Errors } : {}),
      httpStatus: response.status,
      payload,
      raw: body,
    };
  }

  /**
   * Checks which API a token opens, without filing anything: posts an empty body and reads the answer.
   */
  async checkToken(): Promise<{ valid: boolean; message: string; fault?: GatewayFault }> {
    if (this.options.mode !== 'cloud') return { valid: false, message: 'Tokens are only used in cloud mode' };

    const sent = await this.send('{}');
    if ('error' in sent) return { valid: false, message: sent.error.message };

    const fault = readFault(sent.json as Record<string, unknown> | undefined);
    if (fault) return { valid: false, message: fault.hint, fault };

    const body = sent.json as Record<string, unknown> | undefined;
    if (body && typeof body === 'object' && 'Code' in body) {
      return { valid: true, message: `Token opens ${this.url} (IMS answered with code ${String(body.Code)})` };
    }
    return { valid: false, message: `Unexpected answer (HTTP ${sent.response.status}): ${sent.text.slice(0, 200)}` };
  }

  /** Local mode: is the Fiscal Component service running? */
  async health(): Promise<boolean> {
    const url = this.options.url ? new URL('/api/IMSFiscal/Get', this.options.url).toString() : URLS.localHealth;
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      return response.ok && /responding/i.test(await response.text());
    } catch {
      return false;
    }
  }

  private async send(payload: string): Promise<
    | { response: Response; text: string; json: unknown }
    | { error: Omit<FiscalResult, 'payload'> }
  > {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (this.options.mode === 'cloud') headers.Authorization = `Bearer ${this.options.token}`;

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      const code = errorCode(error);
      if (code && NOT_SENT_CODES.has(code)) {
        return { error: { status: 'not_sent', message: `Could not reach FBR (${code}). Nothing was filed; it is safe to send again.` } };
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        error: {
          status: 'unknown',
          message: timedOut
            ? 'Timed out waiting for FBR. The bill may have been filed: check before resending, never resend automatically.'
            : `Connection failed after sending (${code ?? (error as Error).message}). Check before resending.`,
        },
      };
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { response, text, json };
  }
}

function readFault(body: Record<string, unknown> | undefined): GatewayFault | undefined {
  const fault = body?.fault as { code?: unknown; message?: unknown; description?: unknown } | undefined;
  if (!fault || typeof fault !== 'object') return undefined;
  const code = String(fault.code ?? '');
  return {
    code,
    message: [fault.message, fault.description].filter(Boolean).join(': ') || `Gateway fault ${code}`,
    hint: FAULT_HINTS[code] ?? 'FBR gateway refused the request. Check the token and the endpoint.',
  };
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
