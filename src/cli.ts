#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { InvoiceValidationError, buildInvoice, validateImsInvoice } from './build.js';
import { FbrImsClient, SANDBOX_TOKEN } from './client.js';
import type { ImsInvoice } from './types.js';
import type { InvoiceInput } from './build.js';

const USAGE = `fbr-pos: post and check FBR POS (IMS) invoices

Usage
  fbr-pos build <input.json>                  build an IMS payload from line items and print it
  fbr-pos validate <invoice.json>             check a ready-made IMS payload (totals, codes, formats)
  fbr-pos post <file.json> [options]          build if needed, validate, and post to FBR
  fbr-pos check-token [options]               see which API a token opens, without filing anything
  fbr-pos health                              is the local Fiscal Component running?

Options
  --env sandbox|production    cloud environment (default sandbox)
  --token <token>             Bearer token (or FBR_TOKEN). Sandbox uses FBR's shared token by default
  --local                     post to the local Fiscal Component on http://localhost:8524
  --url <url>                 custom endpoint

Input files with an "items" array are treated as line item input (see README) and built first.
Files with "Items" are treated as finished IMS payloads.`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) positional.push(arg);
    else if (arg === '--local' || arg === '--help') flags[arg.slice(2)] = true;
    else flags[arg.slice(2)] = argv[++i] ?? '';
  }
  return { positional, flags };
}

function load(path: string | undefined): ImsInvoice {
  if (!path) throw new Error('Missing file argument');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(data.items) ? buildInvoice(data as InvoiceInput) : (data as ImsInvoice);
}

function clientFrom(flags: Record<string, string | true>): FbrImsClient {
  const env = flags.env === 'production' ? 'production' : 'sandbox';
  if (flags.local) return new FbrImsClient({ mode: 'local', ...(typeof flags.url === 'string' ? { url: flags.url } : {}) });

  const token = (typeof flags.token === 'string' && flags.token) || process.env.FBR_TOKEN || (env === 'sandbox' ? SANDBOX_TOKEN : '');
  if (!token) throw new Error('Production needs --token or FBR_TOKEN');
  return new FbrImsClient({ mode: 'cloud', environment: env, token, ...(typeof flags.url === 'string' ? { url: flags.url } : {}) });
}

async function main(): Promise<number> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, file] = positional;

  switch (command) {
    case 'build':
      console.log(JSON.stringify(load(file), null, 2));
      return 0;

    case 'validate': {
      const issues = validateImsInvoice(load(file));
      if (issues.length === 0) {
        console.log('Looks good.');
        return 0;
      }
      for (const issue of issues) console.log(`- ${issue}`);
      return 1;
    }

    case 'post': {
      const invoice = load(file);
      const client = clientFrom(flags);
      console.error(`Posting USIN ${invoice.USIN} to ${client.endpoint}`);
      const result = await client.post(invoice);
      console.log(JSON.stringify({ ...result, payload: undefined }, null, 2));
      return result.status === 'fiscalized' ? 0 : 1;
    }

    case 'check-token': {
      const result = await clientFrom(flags).checkToken();
      console.log(result.message);
      return result.valid ? 0 : 1;
    }

    case 'health': {
      const ok = await new FbrImsClient({ mode: 'local', ...(typeof flags.url === 'string' ? { url: flags.url } : {}) }).health();
      console.log(ok ? 'Fiscal Component is responding' : 'Fiscal Component is not responding on this machine');
      return ok ? 0 : 1;
    }

    default:
      console.log(USAGE);
      return command ? 2 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof InvoiceValidationError) console.error(error.message);
    else console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
