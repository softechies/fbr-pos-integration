import { describe, expect, it } from 'vitest';
import { FbrImsClient, InvoiceValidationError, SANDBOX_TOKEN, buildInvoice } from '../src/index.js';
import { mockFetch } from './mock-fetch.js';

const invoice = buildInvoice({
  posId: 822922,
  usin: 'POS-0001',
  dateTime: '2026-10-08 11:00:00',
  paymentMode: 'cash',
  items: [{ code: 'SKU-001', name: 'Cotton T-shirt', pctCode: '61091000', quantity: 1, unitPrice: 1000, taxRate: 18 }],
});

function cloud(fetchImpl: typeof fetch, environment: 'sandbox' | 'production' = 'sandbox') {
  return new FbrImsClient({ mode: 'cloud', environment, token: SANDBOX_TOKEN, fetch: fetchImpl });
}

function failingFetch(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as typeof fetch;
}

describe('post', () => {
  it('fiscalizes a bill', async () => {
    const mock = mockFetch({
      json: { InvoiceNumber: '9000052011142444901', Code: '100', Response: 'Fiscal Invoice Number generated successfully.', Errors: null },
    });
    const result = await cloud(mock.fetch).post(invoice);

    const call = mock.calls[0]!;
    expect(call.url).toBe('https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe(`Bearer ${SANDBOX_TOKEN}`);
    expect(call.body).toEqual(invoice);

    expect(result).toMatchObject({ status: 'fiscalized', invoiceNumber: '9000052011142444901', code: '100', httpStatus: 200 });
    expect(JSON.parse(result.payload)).toEqual(invoice);
  });

  it('reads FBRInvoiceNumber and numeric codes too', async () => {
    const mock = mockFetch({ json: { FBRInvoiceNumber: '9000052011142444902', Code: 100, Response: 'Invoice received successfully' } });
    expect(await cloud(mock.fetch).post(invoice)).toMatchObject({ status: 'fiscalized', invoiceNumber: '9000052011142444902' });
  });

  it('treats code 102 as rejected even though an invoice number field is present', async () => {
    const mock = mockFetch({ json: { InvoiceNumber: 'Not Available', Code: '102', Response: 'Invalid data received', Errors: ['PCTCode'] } });
    const result = await cloud(mock.fetch).post(invoice);
    expect(result).toMatchObject({ status: 'rejected', code: '102', message: 'Invalid data received', errors: ['PCTCode'] });
    expect(result.invoiceNumber).toBeUndefined();
  });

  it('explains gateway token faults', async () => {
    const mock = mockFetch({
      status: 403,
      json: { fault: { code: 900908, message: 'Resource forbidden', description: 'Access failure for API: /FBR/v1' } },
    });
    const result = await cloud(mock.fetch).post(invoice);
    expect(result.status).toBe('rejected');
    expect(result.fault?.code).toBe('900908');
    expect(result.fault?.hint).toContain('not for this API');
  });

  it('marks server errors and HTML pages as unknown, never as rejected', async () => {
    expect((await cloud(mockFetch({ status: 502, text: '<html>Bad gateway</html>' }).fetch).post(invoice)).status).toBe('unknown');
    expect((await cloud(mockFetch({ status: 200, text: '<html>Maintenance</html>' }).fetch).post(invoice)).status).toBe('unknown');
  });

  it('marks a timeout as unknown so it is not resent blindly', async () => {
    const result = await cloud(failingFetch(new DOMException('The operation timed out', 'TimeoutError'))).post(invoice);
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('never resend automatically');
  });

  it('marks connection refused as not_sent', async () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const result = await cloud(failingFetch(error)).post(invoice);
    expect(result.status).toBe('not_sent');
  });

  it('refuses to send an invalid payload', async () => {
    const mock = mockFetch();
    await expect(cloud(mock.fetch).post({ ...invoice, PaymentMode: 21 })).rejects.toBeInstanceOf(InvoiceValidationError);
    expect(mock.calls).toHaveLength(0);
  });

  it('uses the production and local endpoints', async () => {
    const prod = mockFetch({ json: { InvoiceNumber: '1', Code: '100' } });
    await cloud(prod.fetch, 'production').post(invoice);
    expect(prod.calls[0]!.url).toBe('https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData');

    const local = mockFetch({ json: { InvoiceNumber: '1', Code: '100' } });
    await new FbrImsClient({ mode: 'local', fetch: local.fetch }).post(invoice);
    expect(local.calls[0]!.url).toBe('http://localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel');
    expect(local.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('requires a token in cloud mode', () => {
    expect(() => new FbrImsClient({ mode: 'cloud' })).toThrow('token');
  });
});

describe('checkToken', () => {
  it('reports a token that opens IMS', async () => {
    const mock = mockFetch({ json: { InvoiceNumber: 'Not Available', Code: '102', Response: 'Invalid data received' } });
    const result = await cloud(mock.fetch).checkToken();
    expect(mock.calls[0]!.body).toEqual({});
    expect(result.valid).toBe(true);
  });

  it('reports a token for another API', async () => {
    const mock = mockFetch({ status: 403, json: { fault: { code: '900908', message: 'Resource forbidden' } } });
    const result = await cloud(mock.fetch).checkToken();
    expect(result).toMatchObject({ valid: false, fault: { code: '900908' } });
  });
});

describe('health', () => {
  it('checks the local Fiscal Component', async () => {
    const up = mockFetch({ json: ['Service is responding'] });
    expect(await new FbrImsClient({ mode: 'local', fetch: up.fetch }).health()).toBe(true);
    expect(up.calls[0]!.url).toBe('http://localhost:8524/api/IMSFiscal/Get');

    const down = new FbrImsClient({ mode: 'local', fetch: failingFetch(new TypeError('fetch failed')) });
    expect(await down.health()).toBe(false);
  });
});
