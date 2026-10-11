/** PaymentMode codes. (The FBR spec PDF prints them as 21-26; the real values are 1-6.) */
export const PaymentMode = {
  cash: 1,
  card: 2,
  giftVoucher: 3,
  loyaltyCard: 4,
  mixed: 5,
  cheque: 6,
} as const;
export type PaymentModeName = keyof typeof PaymentMode;

/** Header InvoiceType codes. (Printed as 27-29 in the spec PDF; the real values are 1-3.) */
export const InvoiceType = {
  new: 1,
  debit: 2,
  credit: 3,
} as const;
export type InvoiceTypeName = keyof typeof InvoiceType;

/**
 * Item InvoiceType codes.
 *   1    new
 *   3    credit (return)
 *   11   Third Schedule item (tax on printed retail price), new
 *   12   Third Schedule item, credit
 *   139  sale of goods under SRO 297(I)/2023
 */
export type ItemInvoiceType = 1 | 3 | 11 | 12 | 139;

/** One line exactly as FBR expects it. Field names are PascalCase and must match. */
export interface ImsItem {
  ItemCode: string;
  ItemName: string;
  /** 8 digits, no dot: 9815.1000 → "98151000" */
  PCTCode: string;
  Quantity: number;
  /** Percent as a number: 18, not "18%" */
  TaxRate: number;
  /** After discount, before tax */
  SaleValue: number;
  Discount: number;
  TaxCharged: number;
  FurtherTax: number;
  TotalAmount: number;
  InvoiceType: ItemInvoiceType;
  RefUSIN: string | null;
}

/** The bill exactly as FBR expects it. */
export interface ImsInvoice {
  /** Always "" when sending. FBR fills it in. */
  InvoiceNumber: string;
  POSID: number;
  /** Your own bill number. Unique per POS, never reused. */
  USIN: string;
  RefUSIN: string | null;
  /** yyyy-MM-dd HH:mm:ss, local time of the sale */
  DateTime: string;
  BuyerName: string;
  BuyerNTN: string;
  /** 13 digits, no dashes */
  BuyerCNIC: string;
  BuyerPhoneNumber: string;
  TotalSaleValue: number;
  TotalTaxCharged: number;
  TotalQuantity: number;
  Discount: number;
  FurtherTax: number;
  TotalBillAmount: number;
  PaymentMode: number;
  InvoiceType: number;
  Items: ImsItem[];
}

/**
 * What happened to a bill.
 *   fiscalized   FBR accepted it and returned a Fiscal Invoice Number. Lock the bill.
 *   rejected     FBR (or its gateway) refused it. Nothing was filed; fix and resend with the SAME USIN.
 *   not_sent     The request never left (DNS, connection refused, TLS). Safe to send again.
 *   unknown      Timed out or a server error after sending. FBR may have filed it.
 *                Do NOT resend automatically: check in IRIS / the verification app first.
 */
export type FiscalStatus = 'fiscalized' | 'rejected' | 'not_sent' | 'unknown';

export interface GatewayFault {
  code: string;
  message: string;
  /** What to do about it. */
  hint: string;
}

export interface FiscalResult {
  status: FiscalStatus;
  /** Fiscal Invoice Number to print on the receipt and in the QR code. */
  invoiceNumber?: string;
  /** IMS response code: "100" is success. */
  code?: string;
  message: string;
  errors?: unknown;
  httpStatus?: number;
  /** Set when FBR's API gateway refused the token (HTTP 401/403). */
  fault?: GatewayFault;
  /** The exact JSON that was sent. Store it on the bill. */
  payload: string;
  /** Raw response body (parsed JSON or text). */
  raw?: unknown;
}
