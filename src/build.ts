import {
  type ImsInvoice,
  type ImsItem,
  type InvoiceTypeName,
  type ItemInvoiceType,
  type PaymentModeName,
  InvoiceType,
  PaymentMode,
} from './types.js';

export class InvoiceValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invoice is not valid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'InvoiceValidationError';
    this.issues = issues;
  }
}

export interface LineInput {
  /** Your product or service code. */
  code: string;
  name: string;
  /** PCT / HS heading, with or without the dot: "6109.1000" or "61091000". */
  pctCode: string;
  quantity: number;
  /** Price per unit before tax. */
  unitPrice: number;
  /** Discount on the whole line, in rupees. Taken off before tax. */
  discount?: number;
  /** Sales tax percent, e.g. 18. */
  taxRate: number;
  furtherTax?: number;
  /** Defaults to 1 (new) or 3 (credit) to follow the bill. Use 11/12 for Third Schedule items. */
  invoiceType?: ItemInvoiceType;
}

export interface BuyerInput {
  name?: string;
  /** 1234567-8 */
  ntn?: string;
  /** With or without dashes; sent as 13 digits. */
  cnic?: string;
  phone?: string;
}

export interface InvoiceInput {
  /** FBR POS ID of the counter (test or production). */
  posId: number;
  /** Your bill number. Generate once when the bill is saved, and reuse it on every resend. */
  usin: string;
  /** Time of sale. A Date is written in Pakistan time. */
  dateTime: Date | string;
  paymentMode: PaymentModeName | number;
  /** Default "new". Credit notes need refUsin. */
  invoiceType?: InvoiceTypeName;
  /** USIN of the original bill, for debit and credit notes. */
  refUsin?: string;
  buyer?: BuyerInput;
  items: LineInput[];
}

/** Rounds half away from zero to 2 decimals without float surprises (1.005 → 1.01). */
export function round2(value: number): number {
  return Math.sign(value) * Math.round(Number((Math.abs(value) * 100).toPrecision(15))) / 100;
}

/** "9815.1000" → "98151000". */
export function normalizePct(pct: string): string {
  return String(pct ?? '').replace(/[.\s-]/g, '');
}

/** Formats a Date as yyyy-MM-dd HH:mm:ss in Pakistan time (UTC+5). */
export function formatFbrDateTime(date: Date): string {
  const t = new Date(date.getTime() + 5 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * Builds an IMS bill from line items. Every amount is calculated the way FBR checks it:
 *   SaleValue   = unitPrice × quantity − discount
 *   TaxCharged  = SaleValue × taxRate / 100
 *   TotalAmount = SaleValue + TaxCharged + furtherTax
 * and the header totals are summed from the item array that is actually sent.
 */
export function buildInvoice(input: InvoiceInput): ImsInvoice {
  const issues: string[] = [];
  const headerType = input.invoiceType ?? 'new';
  const refUsin = input.refUsin?.trim() || null;

  if (!Number.isInteger(input.posId) || input.posId <= 0) issues.push('posId must be the numeric FBR POS ID');
  if (!input.usin?.trim() || input.usin.length > 50) issues.push('usin is required, max 50 characters');
  if (headerType !== 'new' && !refUsin) issues.push(`${headerType} invoices need refUsin (the original bill's USIN)`);
  if (!input.items?.length) issues.push('at least one item is required');

  const paymentMode = typeof input.paymentMode === 'number' ? input.paymentMode : PaymentMode[input.paymentMode];
  if (!Number.isInteger(paymentMode) || paymentMode < 1 || paymentMode > 6) {
    issues.push('paymentMode must be cash, card, giftVoucher, loyaltyCard, mixed, cheque (or 1-6)');
  }

  const defaultItemType: ItemInvoiceType = headerType === 'credit' ? 3 : 1;
  const items: ImsItem[] = (input.items ?? []).map((line, i) => {
    const where = `items[${i}]`;
    const pct = normalizePct(line.pctCode);
    if (!line.code?.trim() || line.code.length > 50) issues.push(`${where}.code is required, max 50 characters`);
    if (!line.name?.trim() || line.name.length > 150) issues.push(`${where}.name is required, max 150 characters`);
    if (!/^\d{8}$/.test(pct)) issues.push(`${where}.pctCode must be 8 digits (got "${line.pctCode}")`);
    if (!(line.quantity > 0)) issues.push(`${where}.quantity must be greater than 0`);
    if (!(line.unitPrice >= 0)) issues.push(`${where}.unitPrice must be 0 or more`);
    if (!(line.taxRate >= 0 && line.taxRate <= 100)) issues.push(`${where}.taxRate must be a percent between 0 and 100`);

    const discount = round2(line.discount ?? 0);
    const furtherTax = round2(line.furtherTax ?? 0);
    const saleValue = round2(line.unitPrice * line.quantity - discount);
    if (saleValue < 0) issues.push(`${where}.discount is larger than the line value`);
    const taxCharged = round2((saleValue * line.taxRate) / 100);

    return {
      ItemCode: line.code?.trim() ?? '',
      ItemName: line.name?.trim() ?? '',
      PCTCode: pct,
      Quantity: line.quantity,
      TaxRate: line.taxRate,
      SaleValue: saleValue,
      Discount: discount,
      TaxCharged: taxCharged,
      FurtherTax: furtherTax,
      TotalAmount: round2(saleValue + taxCharged + furtherTax),
      InvoiceType: line.invoiceType ?? defaultItemType,
      RefUSIN: refUsin,
    };
  });

  const cnic = String(input.buyer?.cnic ?? '').replace(/[\s-]/g, '');
  if (cnic && !/^\d{13}$/.test(cnic)) issues.push('buyer.cnic must be 13 digits');
  const ntn = String(input.buyer?.ntn ?? '').trim();
  if (ntn && !/^\d{7}-?\d$/.test(ntn)) issues.push('buyer.ntn must look like 1234567-8');

  let dateTime = '';
  if (input.dateTime instanceof Date) {
    if (Number.isNaN(input.dateTime.getTime())) issues.push('dateTime is not a valid date');
    else dateTime = formatFbrDateTime(input.dateTime);
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(input.dateTime ?? '')) {
    dateTime = input.dateTime;
  } else {
    issues.push('dateTime must be a Date or "yyyy-MM-dd HH:mm:ss"');
  }

  if (issues.length) throw new InvoiceValidationError(issues);

  const sum = (pick: (item: ImsItem) => number) => round2(items.reduce((total, item) => total + pick(item), 0));

  return {
    InvoiceNumber: '',
    POSID: input.posId,
    USIN: input.usin.trim(),
    RefUSIN: refUsin,
    DateTime: dateTime,
    BuyerName: input.buyer?.name?.trim() ?? '',
    BuyerNTN: ntn ? ntn.replace(/^(\d{7})-?(\d)$/, '$1-$2') : '',
    BuyerCNIC: cnic,
    BuyerPhoneNumber: input.buyer?.phone?.trim() ?? '',
    TotalSaleValue: sum((i) => i.SaleValue),
    TotalTaxCharged: sum((i) => i.TaxCharged),
    TotalQuantity: round2(items.reduce((total, item) => total + item.Quantity, 0)),
    Discount: sum((i) => i.Discount),
    FurtherTax: sum((i) => i.FurtherTax),
    TotalBillAmount: sum((i) => i.TotalAmount),
    PaymentMode: paymentMode,
    InvoiceType: InvoiceType[headerType],
    Items: items,
  };
}

/**
 * Checks a ready-made IMS payload (for example one built by another system) before posting.
 * Returns a list of problems; an empty list means it looks right.
 */
export function validateImsInvoice(invoice: ImsInvoice): string[] {
  const issues: string[] = [];
  const close = (a: number, b: number) => Math.abs(a - b) < 0.011;

  if (invoice.InvoiceNumber !== '') issues.push('InvoiceNumber must be "" when sending');
  if (!Number.isInteger(invoice.POSID)) issues.push('POSID must be a number');
  if (!invoice.USIN || invoice.USIN.length > 50) issues.push('USIN is required, max 50 characters');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(invoice.DateTime)) issues.push('DateTime must be "yyyy-MM-dd HH:mm:ss"');
  if (invoice.BuyerCNIC && !/^\d{13}$/.test(invoice.BuyerCNIC)) issues.push('BuyerCNIC must be 13 digits without dashes');
  if (!(invoice.PaymentMode >= 1 && invoice.PaymentMode <= 6)) issues.push('PaymentMode must be 1-6 (not the 21-26 printed in the spec)');
  if (![1, 2, 3].includes(invoice.InvoiceType)) issues.push('InvoiceType must be 1, 2 or 3 (not the 27-29 printed in the spec)');
  if (invoice.InvoiceType !== 1 && !invoice.RefUSIN) issues.push('RefUSIN is required for debit and credit invoices');
  if (!invoice.Items?.length) issues.push('Items must have at least one line');

  (invoice.Items ?? []).forEach((item, i) => {
    const where = `Items[${i}]`;
    if (!/^\d{8}$/.test(item.PCTCode)) issues.push(`${where}.PCTCode must be 8 digits without a dot`);
    if (!close(item.TaxCharged, (item.SaleValue * item.TaxRate) / 100)) {
      issues.push(`${where}.TaxCharged should be SaleValue × TaxRate / 100 = ${round2((item.SaleValue * item.TaxRate) / 100)}`);
    }
    if (!close(item.TotalAmount, item.SaleValue + item.TaxCharged + (item.FurtherTax ?? 0))) {
      issues.push(`${where}.TotalAmount should be SaleValue + TaxCharged + FurtherTax`);
    }
  });

  const items = invoice.Items ?? [];
  const totals: Array<[keyof ImsInvoice, (item: ImsItem) => number]> = [
    ['TotalSaleValue', (i) => i.SaleValue],
    ['TotalTaxCharged', (i) => i.TaxCharged],
    ['TotalQuantity', (i) => i.Quantity],
    ['TotalBillAmount', (i) => i.TotalAmount],
  ];
  for (const [field, pick] of totals) {
    const expected = round2(items.reduce((total, item) => total + pick(item), 0));
    if (!close(invoice[field] as number, expected)) issues.push(`${field} should be ${expected} (sum of items)`);
  }
  return issues;
}
