# fbr-pos-integration

**FBR POS (IMS) integration for Node.js and TypeScript.** Build Tier-1 retailer and income tax
POS invoices with totals FBR accepts, post them to FBR's cloud API or the local Fiscal Component,
and get back a result you can store safely, including the cases the official samples skip:
timeouts, gateway token errors and HTML error pages.

[![ci](https://github.com/softechies/fbr-pos-integration/actions/workflows/ci.yml/badge.svg)](https://github.com/softechies/fbr-pos-integration/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

```ts
import { buildInvoice, FbrImsClient, SANDBOX_TOKEN } from 'fbr-pos-integration';

const invoice = buildInvoice({
  posId: 822922,                 // your test POS ID from IRIS
  usin: 'POS-0001',              // your bill number
  dateTime: new Date(),
  paymentMode: 'cash',
  items: [
    { code: 'SKU-001', name: 'Cotton T-shirt', pctCode: '6109.1000', quantity: 1, unitPrice: 1000, taxRate: 18 },
    { code: 'SKU-002', name: 'Cotton T-shirt', pctCode: '6109.1000', quantity: 1, unitPrice: 600, discount: 100, taxRate: 18 },
  ],
});

const fbr = new FbrImsClient({ mode: 'cloud', environment: 'sandbox', token: SANDBOX_TOKEN });
const result = await fbr.post(invoice);

if (result.status === 'fiscalized') {
  printReceipt({ fbrInvoiceNumber: result.invoiceNumber }); // plus a QR code of the same number
}
```

## What it gets right

| Problem | What this package does |
|---|---|
| Header totals that don't match the lines | Totals are summed from the exact item array being sent, after rounding each line |
| Discount applied after tax | `SaleValue = price × qty − discount`, then tax, as FBR checks it |
| `PCTCode` sent as `6109.1000` | Normalized to 8 digits: `61091000` |
| `BuyerCNIC` with dashes overflowing the field | Sent as 13 digits |
| PaymentMode 21-26 and InvoiceType 27-29 copied from the spec PDF | Uses the real codes 1-6 and 1-3, and `validateImsInvoice()` flags the wrong ones |
| Treating any `InvoiceNumber` as success | Success needs HTTP 2xx **and** `Code "100"` **and** a real number (code 102 returns `"Not Available"`) |
| Retrying a timeout and filing the bill twice | Timeouts come back as `unknown`, with a warning not to resend automatically |
| `900908` and other gateway errors | Decoded with a plain explanation of the fix |
| `ServerCertificateValidationCallback = true` in the official sample | Certificate checks stay on |
| Server timezone shifting the bill time | `Date` values are written in Pakistan time |

## Install

```bash
npm install fbr-pos-integration
```

Node 20+. No dependencies.

## Cloud or local

| | Cloud | Local Fiscal Component |
|---|---|---|
| Who sends to FBR | Your server, over HTTPS | FBR's Windows service on the POS PC |
| Auth | Bearer token per POS registration | Access code entered once in the installer |
| Fits | Web and cloud POS, multi-branch systems | Desktop POS at each counter |
| Code | `new FbrImsClient({ mode: 'cloud', environment, token })` | `new FbrImsClient({ mode: 'local' })` |

The payload is identical in both.

## Results

`post()` never throws for FBR's answer. Every outcome is a `FiscalResult` to store on the bill:

| `status` | Meaning | What to do |
|---|---|---|
| `fiscalized` | FBR accepted it. `invoiceNumber` is set | Save the number, lock the bill, print it with the QR code |
| `rejected` | FBR or its gateway refused it. Nothing filed | Fix the cause (`code`, `message`, `errors`, `fault.hint`) and resend with the **same USIN** |
| `not_sent` | Never left your server (DNS, connection refused, TLS) | Safe to send again |
| `unknown` | Timeout or server error after sending | **Don't resend automatically.** Check IRIS or FBR's verification app first |

`result.payload` holds the exact JSON that was sent. Keep it with the bill for audits.

## Credit notes and returns

```ts
buildInvoice({
  posId: 822922,
  usin: 'POS-0001-R',
  refUsin: 'POS-0001',       // the original bill
  invoiceType: 'credit',
  dateTime: new Date(),
  paymentMode: 'cash',
  items: [{ code: 'SKU-002', name: 'Cotton T-shirt (return)', pctCode: '61091000', quantity: 1, unitPrice: 500, taxRate: 18 }],
});
```

Item types follow the bill (1 for new, 3 for credit). Set `invoiceType: 11` (or 12 for returns) on
Third Schedule items taxed on the printed retail price.

## Command line

```bash
npx fbr-pos build examples/retail-bill.json         # print the IMS payload with all totals
npx fbr-pos validate my-invoice.json                # check a payload from another system
npx fbr-pos check-token --token $FBR_TOKEN --env production   # which API does this token open?
npx fbr-pos post examples/retail-bill.json          # post to the sandbox with the shared token
npx fbr-pos health                                  # is the local Fiscal Component running?
```

## Integration rules worth following

- **Commit the bill first, call FBR after**, outside your database transaction. A slow FBR must
  never roll back a real sale.
- **One USIN per bill, forever.** Generate it when the bill is saved and reuse it on every resend.
- **Lock fiscalized bills.** Corrections go through a credit note and a new bill.
- **One POS ID per counter.** Don't file every counter's sales against one terminal.
- **Build a fiscalization screen**: bills with their status and a manual "Post" button. Network
  drops happen, and that screen is how the day gets reconciled.
- **Receipts** need the Fiscal Invoice Number, a QR code of that number (about 0.7 to 1 inch) and
  the FBR POS logo. Print the FBR block only when a number exists.
- **Store the production token on the server, encrypted.** Never in a desktop app or the browser.

## Endpoints

| | URL |
|---|---|
| Sandbox | `https://esp.fbr.gov.pk:8244/FBR/v1/api/Live/PostData` |
| Production | `https://gw.fbr.gov.pk/imsp/v1/api/Live/PostData` |
| Local component | `http://localhost:8524/api/IMSFiscal/GetInvoiceNumberByModel` |

Pass `url` to override. The sandbox uses FBR's shared token (`SANDBOX_TOKEN`) together with **your
own** test POS ID generated in IRIS.

This package covers IMS (Tier-1 retail and income tax POS). FBR's separate **Digital Invoicing**
(PRAL, for manufacturers and wholesalers) and **POS Digital Invoicing** APIs use different
payloads and tokens and are not covered yet.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Tests run against recorded FBR responses, including the reference retail bill from a public
integration kit, which the builder reproduces field for field.

## License

MIT. Not affiliated with the Federal Board of Revenue. Confirm tax rates and PCT headings with
your tax advisor; this package calculates what you give it.

---

Built and maintained by [Softechies Solutions](https://softechies.net). We build FBR-integrated
POS, billing and ERP systems. For receipt printing see
[dotnet-escpos-printer](https://github.com/softechies/dotnet-escpos-printer).
