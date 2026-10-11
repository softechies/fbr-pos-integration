import { describe, expect, it } from 'vitest';
import { InvoiceValidationError, buildInvoice, formatFbrDateTime, normalizePct, validateImsInvoice } from '../src/index.js';
import type { ImsInvoice } from '../src/index.js';

/**
 * Retail scenario IMS-R01 from a public FBR integration kit: two garments at 18%,
 * the second with a Rs 100 discount. The builder must produce exactly this payload.
 */
const R01: ImsInvoice = {
  InvoiceNumber: '',
  POSID: 110014,
  USIN: 'POS-TEST-0001',
  RefUSIN: null,
  DateTime: '2026-10-08 11:00:00',
  BuyerName: '',
  BuyerNTN: '',
  BuyerCNIC: '',
  BuyerPhoneNumber: '',
  TotalSaleValue: 1500,
  TotalTaxCharged: 270,
  TotalQuantity: 2,
  Discount: 100,
  FurtherTax: 0,
  TotalBillAmount: 1770,
  PaymentMode: 1,
  InvoiceType: 1,
  Items: [
    {
      ItemCode: 'SKU-001', ItemName: 'Cotton T-shirt', PCTCode: '61091000', Quantity: 1, TaxRate: 18,
      SaleValue: 1000, Discount: 0, TaxCharged: 180, FurtherTax: 0, TotalAmount: 1180, InvoiceType: 1, RefUSIN: null,
    },
    {
      ItemCode: 'SKU-002', ItemName: 'Cotton T-shirt (promo)', PCTCode: '61091000', Quantity: 1, TaxRate: 18,
      SaleValue: 500, Discount: 100, TaxCharged: 90, FurtherTax: 0, TotalAmount: 590, InvoiceType: 1, RefUSIN: null,
    },
  ],
};

describe('buildInvoice', () => {
  it('reproduces the reference retail bill', () => {
    const invoice = buildInvoice({
      posId: 110014,
      usin: 'POS-TEST-0001',
      dateTime: '2026-10-08 11:00:00',
      paymentMode: 'cash',
      items: [
        { code: 'SKU-001', name: 'Cotton T-shirt', pctCode: '6109.1000', quantity: 1, unitPrice: 1000, taxRate: 18 },
        { code: 'SKU-002', name: 'Cotton T-shirt (promo)', pctCode: '6109.1000', quantity: 1, unitPrice: 600, discount: 100, taxRate: 18 },
      ],
    });
    expect(invoice).toEqual(R01);
    expect(validateImsInvoice(invoice)).toEqual([]);
  });

  it('builds a credit note against the original bill', () => {
    const credit = buildInvoice({
      posId: 110014,
      usin: 'OPD-TEST-0001-R',
      refUsin: 'OPD-TEST-0001',
      invoiceType: 'credit',
      dateTime: '2026-10-08 11:00:00',
      paymentMode: 'cash',
      buyer: { name: 'Test Patient', cnic: '35202-1234567-1', phone: '03001234567' },
      items: [{ code: 'CONS-SPEC', name: 'Specialist consultation (refund)', pctCode: '98151000', quantity: 1, unitPrice: 2500, taxRate: 0 }],
    });

    expect(credit).toMatchObject({ InvoiceType: 3, RefUSIN: 'OPD-TEST-0001', BuyerCNIC: '3520212345671', TotalBillAmount: 2500 });
    expect(credit.Items[0]).toMatchObject({ InvoiceType: 3, RefUSIN: 'OPD-TEST-0001' });
  });

  it('rounds each line and sums the header from the rounded lines', () => {
    const invoice = buildInvoice({
      posId: 1,
      usin: 'B-1',
      dateTime: '2026-10-08 11:00:00',
      paymentMode: 'card',
      items: [
        { code: 'A', name: 'A', pctCode: '21069090', quantity: 3, unitPrice: 33.33, taxRate: 18 },
        { code: 'B', name: 'B', pctCode: '21069090', quantity: 1, unitPrice: 0.05, taxRate: 18, furtherTax: 0.01 },
      ],
    });
    expect(invoice.Items.map((i) => [i.SaleValue, i.TaxCharged, i.TotalAmount])).toEqual([
      [99.99, 18, 117.99],
      [0.05, 0.01, 0.07],
    ]);
    expect(invoice).toMatchObject({ TotalSaleValue: 100.04, TotalTaxCharged: 18.01, FurtherTax: 0.01, TotalBillAmount: 118.06, PaymentMode: 2 });
  });

  it('keeps Third Schedule item types', () => {
    const invoice = buildInvoice({
      posId: 1, usin: 'B-2', dateTime: '2026-10-08 11:00:00', paymentMode: 'cash',
      items: [{ code: 'BEV-500', name: 'Soft drink 500ml', pctCode: '22021010', quantity: 1, unitPrice: 100, taxRate: 18, invoiceType: 11 }],
    });
    expect(invoice.Items[0]!.InvoiceType).toBe(11);
  });

  it('writes Date values in Pakistan time', () => {
    expect(formatFbrDateTime(new Date('2026-10-08T06:00:00Z'))).toBe('2026-10-08 11:00:00');
    expect(formatFbrDateTime(new Date('2026-10-08T21:30:05Z'))).toBe('2026-10-09 02:30:05');
  });

  it('collects every problem at once', () => {
    try {
      buildInvoice({
        posId: 0,
        usin: '',
        invoiceType: 'credit',
        dateTime: '08/10/2026',
        paymentMode: 9,
        buyer: { cnic: '35202-123', ntn: 'abc' },
        items: [{ code: 'X', name: 'X', pctCode: '6109.10', quantity: 0, unitPrice: 10, discount: 50, taxRate: 18 }],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvoiceValidationError);
      const issues = (error as InvoiceValidationError).issues.join('\n');
      for (const fragment of ['posId', 'usin', 'refUsin', 'paymentMode', 'pctCode', 'quantity', 'discount', 'cnic', 'ntn', 'dateTime']) {
        expect(issues).toContain(fragment);
      }
    }
  });

  it('normalizes PCT codes', () => {
    expect(normalizePct('9815.1000')).toBe('98151000');
    expect(normalizePct(' 6109 1000 ')).toBe('61091000');
  });
});

describe('validateImsInvoice', () => {
  it('catches the mistakes copied from the spec PDF', () => {
    const bad: ImsInvoice = {
      ...R01,
      PaymentMode: 21,
      InvoiceType: 27,
      BuyerCNIC: '35202-1234567-1',
      Items: [{ ...R01.Items[0]!, PCTCode: '6109.1000', TotalAmount: 1000 }, R01.Items[1]!],
    };
    const issues = validateImsInvoice(bad).join('\n');
    expect(issues).toContain('PaymentMode must be 1-6');
    expect(issues).toContain('InvoiceType must be 1, 2 or 3');
    expect(issues).toContain('BuyerCNIC must be 13 digits');
    expect(issues).toContain('PCTCode must be 8 digits');
    expect(issues).toContain('Items[0].TotalAmount');
    expect(issues).toContain('TotalBillAmount should be 1590');
  });
});
