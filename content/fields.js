// Agenda topic: Structured field extraction.
// Lab: Field extraction studio. The workbench (src/workbenches/fields.js) draws result.view:
// the page, one card per schema field, the evidence region each value came from, the
// validation rules and the human review queue.
import { rng, clamp, round, step, metric } from '../src/engine/util.js';

// ---------- sample documents (page units: 210 x 297, like A4 in mm; same model as ingestion) ----------
// facts: concept -> candidate evidence on the page. { item, span (text as printed), read? (what OCR read), conf }
const DOCS = {
  invoice: {
    label: 'Supplier invoice (clean PDF)', kind: 'invoice', quality: 1,
    summary: 'Office supplies: copy paper, toner and delivery',
    items: [
      { id: 'h1', role: 'title', x: 14, y: 24, size: 9, text: 'CONTOSO SUPPLIES LTD' },
      { id: 'h2', role: 'pageHeader', x: 14, y: 32, size: 4.2, text: '14 Mill Lane, Leeds LS1 4AB · VAT GB 123 4567 89' },
      { id: 'h3', role: 'sectionHeading', x: 140, y: 24, size: 8, text: 'INVOICE' },
      { id: 'l1', role: 'text', x: 140, y: 34, size: 4.6, text: 'Invoice no: INV-10442' },
      { id: 'l2', role: 'text', x: 140, y: 41, size: 4.6, text: 'Date: 2026-09-14' },
      { id: 'l3', role: 'text', x: 140, y: 48, size: 4.6, text: 'Due: 2026-10-14' },
      { id: 'l4', role: 'text', x: 140, y: 55, size: 4.6, text: 'PO ref: PO-5521' },
      { id: 'b1', role: 'sectionHeading', x: 14, y: 60, size: 5, text: 'Bill to' },
      { id: 'b2', role: 'text', x: 14, y: 68, size: 4.6, text: 'Fabrikam Retail plc' },
      { id: 'b3', role: 'text', x: 14, y: 75, size: 4.6, text: '12 Harbour Road, Hull HU1 2AA' },
      { id: 't1', role: 'table', x: 14, y: 92, colW: [86, 26, 32, 38], rowH: 11,
        rows: [['Description', 'Qty', 'Unit price', 'Amount'], ['Copy paper A4, 5 reams', '10', '4.50', '45.00'], ['Toner cartridge XL', '2', '90.00', '180.00'], ['Delivery', '1', '15.00', '15.00']] },
      { id: 's1', role: 'text', x: 128, y: 154, size: 4.6, text: 'Subtotal: 240.00' },
      { id: 's2', role: 'text', x: 128, y: 162, size: 4.6, text: 'VAT 20%: 48.00' },
      { id: 's3', role: 'text', x: 128, y: 172, size: 5.6, text: 'TOTAL DUE: GBP 288.00' },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Payment within 30 days · Page 1 of 1' },
    ],
    facts: {
      vendor: [{ item: 'h1', span: 'CONTOSO SUPPLIES LTD', conf: 0.97 }],
      customer: [{ item: 'b2', span: 'Fabrikam Retail plc', conf: 0.95 }],
      docId: [{ item: 'l1', span: 'INV-10442', conf: 0.98 }],
      issueDate: [{ item: 'l2', span: '2026-09-14', conf: 0.97 }],
      dueDate: [{ item: 'l3', span: '2026-10-14', conf: 0.96 }],
      poNumber: [{ item: 'l4', span: 'PO-5521', conf: 0.96 }],
      subtotal: [{ item: 's1', span: '240.00', conf: 0.97 }],
      taxRate: [{ item: 's2', span: '20%', conf: 0.96 }],
      tax: [{ item: 's2', span: '48.00', conf: 0.96 }],
      total: [{ item: 's3', span: '288.00', conf: 0.98, currency: 'GBP' }],
    },
  },
  receipt: {
    label: 'Café receipt (scanned)', kind: 'receipt', quality: 0.9,
    summary: 'Breakfast: coffee, croissant and juice',
    items: [
      { id: 'h1', role: 'title', x: 62, y: 40, size: 8, text: 'NORTHWIND CAFE' },
      { id: 'h2', role: 'pageHeader', x: 62, y: 47, size: 4.2, text: '1 Harbour St, Hull · VAT reg 998 1122 33' },
      { id: 'l1', role: 'text', x: 62, y: 58, size: 4.6, text: '2026-10-02' },
      { id: 'l1b', role: 'text', x: 92, y: 58, size: 4.6, text: '08:41 · Till 3' },
      { id: 'l2', role: 'text', x: 62, y: 72, size: 5, text: 'Flat white' },
      { id: 'l2a', role: 'text', x: 124, y: 72, size: 5, text: '3.40' },
      { id: 'l3', role: 'text', x: 62, y: 81, size: 5, text: 'Croissant' },
      { id: 'l3a', role: 'text', x: 124, y: 81, size: 5, text: '2.60' },
      { id: 'l4', role: 'text', x: 62, y: 90, size: 5, text: 'Orange juice' },
      { id: 'l4a', role: 'text', x: 124, y: 90, size: 5, text: '2.95' },
      { id: 'ls', role: 'text', x: 62, y: 104, size: 5, text: 'Subtotal' },
      { id: 'lsa', role: 'text', x: 124, y: 104, size: 5, text: '7.46' },
      { id: 'lt', role: 'text', x: 62, y: 113, size: 5, text: 'VAT 20%' },
      { id: 'lta', role: 'text', x: 124, y: 113, size: 5, text: '1.49' },
      { id: 's3', role: 'text', x: 62, y: 125, size: 6, text: 'TOTAL' },
      { id: 's3a', role: 'text', x: 120.6, y: 125, size: 6, text: '8.95' },
      { id: 'l5', role: 'text', x: 62, y: 137, size: 4.6, text: 'VISA ****4417 · APPROVED' },
      { id: 'f1', role: 'pageFooter', x: 62, y: 152, size: 4.2, text: 'Thank you! Keep this receipt.' },
    ],
    facts: {
      vendor: [{ item: 'h1', span: 'NORTHWIND CAFE', conf: 0.95 }],
      issueDate: [{ item: 'l1', span: '2026-10-02', conf: 0.94 }],
      subtotal: [{ item: 'lsa', span: '7.46', conf: 0.93 }],
      taxRate: [{ item: 'lt', span: '20%', conf: 0.9 }],
      tax: [{ item: 'lta', span: '1.49', conf: 0.93 }],
      total: [{ item: 's3a', span: '8.95', conf: 0.95 }],
    },
  },
  po: {
    label: 'Purchase order (buyer letterhead)', kind: 'purchase order', quality: 1,
    summary: 'Freight services: four pallets Leeds to Hull plus fuel surcharge',
    items: [
      { id: 'h1', role: 'title', x: 14, y: 24, size: 9, text: 'LITWARE INC' },
      { id: 'h2', role: 'pageHeader', x: 14, y: 32, size: 4.2, text: 'Procurement · 5 Dock Road, Leeds LS10 1AA' },
      { id: 'h3', role: 'sectionHeading', x: 124, y: 24, size: 7, text: 'PURCHASE ORDER' },
      { id: 'l1', role: 'text', x: 124, y: 34, size: 4.6, text: 'PO number: PO-88213' },
      { id: 'l2', role: 'text', x: 124, y: 41, size: 4.6, text: 'Order date: 2026-09-01' },
      { id: 'l3', role: 'text', x: 124, y: 48, size: 4.6, text: 'Deliver by: 2026-09-20' },
      { id: 'v1', role: 'sectionHeading', x: 14, y: 58, size: 5, text: 'Supplier' },
      { id: 'v2', role: 'text', x: 14, y: 66, size: 4.6, text: 'Adatum Logistics Ltd' },
      { id: 'v3', role: 'text', x: 14, y: 73, size: 4.6, text: 'Unit 9, Docklands, Hull HU9 1TA' },
      { id: 'c1', role: 'text', x: 124, y: 66, size: 4.6, text: 'Cost centre: CC-410' },
      { id: 't1', role: 'table', x: 14, y: 90, colW: [92, 20, 34, 36], rowH: 11,
        rows: [['Item', 'Qty', 'Unit', 'Amount'], ['Pallet freight Leeds-Hull', '4', '240.00', '960.00'], ['Fuel surcharge', '1', '280.50', '280.50']] },
      { id: 's1', role: 'text', x: 128, y: 144, size: 4.6, text: 'Net: 1,240.50' },
      { id: 's2', role: 'text', x: 128, y: 152, size: 4.6, text: 'VAT 20%: 248.10' },
      { id: 's3', role: 'text', x: 112, y: 162, size: 5.6, text: 'ORDER TOTAL: GBP 1,488.60' },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Quote the PO number on every invoice' },
    ],
    facts: {
      customer: [{ item: 'h1', span: 'LITWARE INC', conf: 0.95 }],
      vendor: [{ item: 'v2', span: 'Adatum Logistics Ltd', conf: 0.94 }],
      poNumber: [{ item: 'l1', span: 'PO-88213', conf: 0.97 }],
      orderDate: [{ item: 'l2', span: '2026-09-01', conf: 0.96 }],
      deliveryDate: [{ item: 'l3', span: '2026-09-20', conf: 0.95 }],
      costCentre: [{ item: 'c1', span: 'CC-410', conf: 0.95 }],
      subtotal: [{ item: 's1', span: '1,240.50', conf: 0.95 }],
      taxRate: [{ item: 's2', span: '20%', conf: 0.9 }],
      tax: [{ item: 's2', span: '248.10', conf: 0.95 }],
      total: [{ item: 's3', span: '1,488.60', conf: 0.96, currency: 'GBP' }],
    },
  },
  scan: {
    label: 'Scanned invoice (two dates, smudged digits)', kind: 'invoice', quality: 0.62,
    summary: 'Coffee supplies: espresso beans and paper cups',
    items: [
      { id: 'h1', role: 'title', x: 14, y: 24, size: 8.5, text: 'FOURTH COFFEE ROASTERS' },
      { id: 'h2', role: 'pageHeader', x: 14, y: 32, size: 4.2, text: '22 Bean Street, York YO1 7HH' },
      { id: 'h3', role: 'sectionHeading', x: 130, y: 24, size: 7.5, text: 'INVOICE' },
      { id: 'l1', role: 'text', x: 130, y: 34, size: 4.6, text: 'Invoice no: FC-2291' },
      { id: 'l0', role: 'text', x: 130, y: 41, size: 4.6, text: 'Order date: 11/09/2026' },
      { id: 'l2', role: 'text', x: 130, y: 48, size: 4.6, text: 'Invoice date: 13/09/2026' },
      { id: 'l3', role: 'text', x: 130, y: 55, size: 4.6, text: 'Due: 13/10/2026' },
      { id: 'b1', role: 'sectionHeading', x: 14, y: 60, size: 5, text: 'Bill to' },
      { id: 'b2', role: 'text', x: 14, y: 68, size: 4.6, text: 'Fabrikam Retail plc' },
      { id: 't1', role: 'table', x: 14, y: 86, colW: [100, 30, 52], rowH: 11,
        rows: [['Item', 'Qty', 'Amount'], ['Espresso beans 1kg', '6', '78.00'], ['Paper cups (500)', '1', '26.50']] },
      { id: 's1', role: 'text', x: 128, y: 138, size: 4.6, text: 'Subtotal: 104.50' },
      { id: 's2', role: 'text', x: 128, y: 146, size: 4.6, text: 'VAT 20%: 20.90' },
      { id: 's3', role: 'text', x: 128, y: 156, size: 5.6, text: 'TOTAL: GBP 125.40' },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Scanned 2026-09-15 · 200 dpi' },
    ],
    facts: {
      vendor: [{ item: 'h1', span: 'FOURTH COFFEE ROASTERS', conf: 0.93 }],
      customer: [{ item: 'b2', span: 'Fabrikam Retail plc', conf: 0.9 }],
      docId: [{ item: 'l1', span: 'FC-2291', conf: 0.91 }],
      orderDate: [{ item: 'l0', span: '11/09/2026', conf: 0.9 }],
      issueDate: [{ item: 'l2', span: '13/09/2026', conf: 0.9 }],
      dueDate: [{ item: 'l3', span: '13/10/2026', conf: 0.9 }],
      subtotal: [{ item: 's1', span: '104.50', read: '1O4.50', conf: 0.9 }],
      taxRate: [{ item: 's2', span: '20%', conf: 0.87 }],
      tax: [{ item: 's2', span: '20.90', conf: 0.91 }],
      total: [{ item: 's3', span: '125.40', conf: 0.92, currency: 'GBP' }],
    },
  },
  handwritten: {
    label: 'Handwritten invoice (sole trader)', kind: 'invoice', quality: 0.9,
    summary: 'Plumbing: kitchen tap replacement and call-out',
    items: [
      { id: 'h1', role: 'title', x: 14, y: 24, size: 9, text: 'TAILWIND PLUMBING' },
      { id: 'h2', role: 'pageHeader', x: 14, y: 32, size: 4.2, text: 'Sole trader · not VAT registered · 07700 900123' },
      { id: 'h3', role: 'sectionHeading', x: 140, y: 24, size: 8, text: 'INVOICE' },
      { id: 'q1', role: 'text', x: 140, y: 36, size: 4.6, text: 'No:' },
      { id: 'a1', role: 'text', x: 154, y: 36, size: 6, text: 'TP-0412', hand: true },
      { id: 'q2', role: 'text', x: 140, y: 45, size: 4.6, text: 'Date:' },
      { id: 'a2', role: 'text', x: 154, y: 45, size: 6, text: '06/10/2026', hand: true },
      { id: 'q3', role: 'text', x: 140, y: 54, size: 4.6, text: 'Due:' },
      { id: 'a3', role: 'text', x: 154, y: 54, size: 6, text: 'TBC', hand: true },
      { id: 'q4', role: 'text', x: 14, y: 66, size: 4.6, text: 'Customer:' },
      { id: 'a4', role: 'text', x: 38, y: 66, size: 6, text: 'Mrs J. Patel', hand: true },
      { id: 'q5', role: 'sectionHeading', x: 14, y: 82, size: 5, text: 'Work done' },
      { id: 'd1', role: 'text', x: 14, y: 94, size: 6, text: 'Replace kitchen tap (parts + labour)', hand: true },
      { id: 'e1', role: 'text', x: 160, y: 94, size: 6, text: '180.00', hand: true },
      { id: 'd2', role: 'text', x: 14, y: 106, size: 6, text: 'Call-out charge', hand: true },
      { id: 'e2', role: 'text', x: 160, y: 106, size: 6, text: '60.00', hand: true },
      { id: 'q6', role: 'text', x: 128, y: 128, size: 5.6, text: 'TOTAL £' },
      { id: 'a5', role: 'text', x: 156, y: 128, size: 7.5, text: '240.00', hand: true },
      { id: 'f1', role: 'pageFooter', x: 14, y: 284, size: 4, text: 'Bank transfer only · thank you' },
    ],
    facts: {
      vendor: [{ item: 'h1', span: 'TAILWIND PLUMBING', conf: 0.96 }],
      customer: [{ item: 'a4', span: 'Mrs J. Patel', conf: 0.71 }],
      docId: [{ item: 'a1', span: 'TP-0412', conf: 0.74 }],
      issueDate: [{ item: 'a2', span: '06/10/2026', conf: 0.69 }],
      dueDate: [{ item: 'a3', span: 'TBC', conf: 0.82 }],
      total: [{ item: 'a5', span: '240.00', conf: 0.58 }],
    },
  },
};

// ---------- concepts: what a field *means*, so names and descriptions can be resolved to evidence ----------
const CONCEPTS = {
  vendor: { label: 'supplier / vendor name', group: 'party' },
  customer: { label: 'customer / buyer name', group: 'party' },
  docId: { label: 'document number', group: 'id' },
  poNumber: { label: 'purchase order number', group: 'id' },
  costCentre: { label: 'cost centre', group: 'id' },
  issueDate: { label: 'issue / transaction date', group: 'date' },
  orderDate: { label: 'order date', group: 'date' },
  dueDate: { label: 'payment due date', group: 'date' },
  deliveryDate: { label: 'delivery date', group: 'date' },
  subtotal: { label: 'subtotal (net)', group: 'amount' },
  tax: { label: 'tax amount', group: 'amount' },
  taxRate: { label: 'tax rate', group: 'amount' },
  total: { label: 'grand total', group: 'amount' },
};

const ALIASES = {
  vendor: ['vendorname', 'vendor', 'supplier', 'suppliername', 'seller', 'merchant', 'merchantname'],
  customer: ['customername', 'customer', 'buyer', 'buyername', 'billto', 'client', 'clientname'],
  docId: ['invoiceid', 'invoicenumber', 'invoiceno', 'receiptnumber', 'documentnumber', 'documentid'],
  poNumber: ['purchaseorder', 'ponumber', 'purchaseordernumber', 'poref', 'ordernumber'],
  costCentre: ['costcentre', 'costcenter'],
  issueDate: ['invoicedate', 'transactiondate', 'receiptdate', 'documentdate', 'issuedate'],
  orderDate: ['orderdate', 'podate', 'purchaseorderdate'],
  dueDate: ['duedate', 'paymentduedate', 'paymentdue'],
  deliveryDate: ['deliverydate', 'deliverby'],
  subtotal: ['subtotal', 'netamount', 'nettotal', 'net'],
  tax: ['totaltax', 'taxamount', 'vatamount', 'totalvat'],
  taxRate: ['taxrate', 'vatrate'],
  total: ['invoicetotal', 'total', 'totalamount', 'amountdue', 'grandtotal', 'totaldue', 'ordertotal'],
};
// Generic names that match several concepts: the classic "vague field" problem.
const GENERIC = {
  date: ['issueDate', 'orderDate', 'dueDate', 'deliveryDate'],
  tax: ['taxRate', 'tax'], vat: ['taxRate', 'tax'],
  id: ['docId', 'poNumber'], number: ['docId', 'poNumber'], reference: ['docId', 'poNumber'], ref: ['docId', 'poNumber'],
  name: ['vendor', 'customer'], company: ['vendor', 'customer'],
  amount: ['total', 'subtotal'],
};
// Description keywords (checked in order) that pin a field to one concept.
const DESC_RULES = [
  [/\bdue\b|payable by|pay by/, 'dueDate'],
  [/order(ed)? (date|on)|date .*order/, 'orderDate'],
  [/deliver/, 'deliveryDate'],
  [/issued?|invoice date|date of (the )?invoice|transaction|dated/, 'issueDate'],
  [/rate|percent|%/, 'taxRate'],
  [/(vat|tax) (amount|value|charged)|amount of (vat|tax)|(vat|tax) in /, 'tax'],
  [/purchase order|po number/, 'poNumber'],
  [/cost cent/, 'costCentre'],
  [/invoice (number|no|id)|document number/, 'docId'],
  [/supplier|seller|vendor|merchant|issued by/, 'vendor'],
  [/customer|buyer|bill(ed)? to/, 'customer'],
  [/subtotal|before tax|net amount|excluding/, 'subtotal'],
  [/grand total|amount due|total (amount|due|payable)|including (vat|tax)/, 'total'],
];

// Document Intelligence prebuilt-invoice field names this lab models (a subset of the real model's fields).
const PREBUILT = { VendorName: 'vendor', CustomerName: 'customer', InvoiceId: 'docId', PurchaseOrder: 'poNumber', InvoiceDate: 'issueDate', DueDate: 'dueDate', SubTotal: 'subtotal', TotalTax: 'tax', InvoiceTotal: 'total', AmountDue: 'total' };
const PREBUILT_BY_CONCEPT = Object.fromEntries(Object.entries(PREBUILT).map(([k, v]) => [v, k]));

const APPROACHES = {
  cu: { label: 'Content Understanding custom analyzer (your schema)', short: 'CU analyzer' },
  prebuilt: { label: 'Document Intelligence prebuilt-invoice (fixed schema)', short: 'prebuilt-invoice' },
  llm: { label: 'LLM prompt + JSON schema (structured outputs)', short: 'LLM + json_schema' },
};
const KIND_PENALTY = { invoice: 0, receipt: 0.14, 'purchase order': 0.08 }; // prebuilt-invoice on a non-invoice
const RECEIVED = '2026-10-20'; // the date this lab "receives" every document

const DEFAULT_SCHEMA = [
  'VendorName: string required',
  'InvoiceId: string required',
  'InvoiceDate: date required',
  'DueDate: date',
  'SubTotal: number',
  'TotalTax: number',
  'InvoiceTotal: number required',
].join('\n');

const charW = size => size * 0.52;
const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- schema parsing ----------
// Syntax per line: Name: type [required] [extract|generate|classify] [# description]
// type: string | number | integer | date | enum(a|b|c)
const LINE_RE = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(string|number|integer|date|enum\(([^)]*)\))((?:\s+(?:required|extract|generate|classify))*)\s*(?:#\s*(.*))?$/;
function parseSchema(text) {
  const lines = String(text || '').split('\n');
  const out = { ok: true, fields: [], lines: [], error: null };
  const seen = new Set();
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const rec = { n: i + 1, text: raw, ok: true, msg: '' };
    out.lines.push(rec);
    if (!t || t.startsWith('//')) { rec.blank = true; return; }
    const m = t.match(LINE_RE);
    if (!m) {
      rec.ok = false;
      if (!t.includes(':')) rec.msg = 'Missing ":" between the field name and its type.';
      else {
        const ty = t.split(':')[1].trim().split(/\s+/)[0] || '';
        if (!/^(string|number|integer|date|enum\()/.test(ty)) rec.msg = `Unknown type "${ty}". Use string, number, integer, date or enum(a|b).`;
        else if (!/^[A-Za-z]/.test(t)) rec.msg = 'Field names must start with a letter.';
        else rec.msg = 'Unrecognised modifier. Allowed: required, extract, generate, classify, then an optional # description.';
      }
    } else {
      const [, name, typeRaw, enumBody, mods, desc] = m;
      const modList = (mods || '').trim().split(/\s+/).filter(Boolean);
      const isEnum = typeRaw.startsWith('enum');
      const options = isEnum ? enumBody.split('|').map(x => x.trim()).filter(Boolean) : null;
      const method = modList.find(x => x !== 'required') || (isEnum ? 'classify' : 'extract');
      if (seen.has(name.toLowerCase())) { rec.ok = false; rec.msg = `Duplicate field "${name}".`; }
      else if (isEnum && (!options || options.length < 2)) { rec.ok = false; rec.msg = 'enum(...) needs at least two options separated by |.'; }
      else if (method === 'classify' && !isEnum) { rec.ok = false; rec.msg = 'classify needs an enum(...) type listing the allowed categories.'; }
      else {
        seen.add(name.toLowerCase());
        out.fields.push({ name, type: isEnum ? 'enum' : typeRaw, options, required: modList.includes('required'), method, desc: (desc || '').trim(), line: i + 1 });
      }
    }
    if (!rec.ok && !out.error) { out.ok = false; out.error = rec; }
  });
  if (out.ok && !out.fields.length) { out.ok = false; out.error = { n: 1, text: '', msg: 'The schema has no fields.' }; }
  return out;
}

// Which concept(s) does a field ask for? Returns { concepts: [...], how }.
function resolve(field, approach) {
  if (approach === 'prebuilt') {
    const c = PREBUILT[field.name];
    if (c) return { concepts: [c], how: `prebuilt field ${field.name}` };
    const close = Object.keys(PREBUILT).find(k => k.toLowerCase() === field.name.toLowerCase());
    const byAlias = conceptFromName(field.name);
    const hint = close ? ` Did you mean ${close}? (field names are case-sensitive)` : byAlias.length === 1 && PREBUILT_BY_CONCEPT[byAlias[0]] ? ` The closest prebuilt field is ${PREBUILT_BY_CONCEPT[byAlias[0]]}.` : byAlias.length > 1 ? ` Candidates: ${byAlias.map(x => PREBUILT_BY_CONCEPT[x]).filter(Boolean).join(', ') || 'none'}.` : '';
    return { concepts: [], how: `not a prebuilt-invoice field.${hint}` };
  }
  if (field.desc) {
    const d = field.desc.toLowerCase();
    for (const [re, c] of DESC_RULES) if (re.test(d)) return { concepts: [c], how: `description "${field.desc}"` };
  }
  const byName = conceptFromName(field.name);
  if (byName.length) return { concepts: byName, how: byName.length > 1 ? `generic name "${field.name}"` : `field name ${field.name}` };
  return { concepts: [], how: `nothing in the name${field.desc ? ' or description' : ''} matches content on the page` };
}
function conceptFromName(name) {
  const n = norm(name);
  for (const [c, list] of Object.entries(ALIASES)) if (list.includes(n)) return [c];
  if (GENERIC[n]) return GENERIC[n];
  return [];
}

// ---------- evidence geometry ----------
function spanBox(doc, fact) {
  const it = doc.items.find(i => i.id === fact.item);
  const idx = Math.max(0, it.text.indexOf(fact.span));
  return { x: round(it.x + idx * charW(it.size) - 0.8, 2), y: round(it.y - it.size * 0.9, 2), w: round(fact.span.length * charW(it.size) + 1.6, 2), h: round(it.size * 1.25, 2) };
}
const polygon = b => [b.x, b.y, b.x + b.w, b.y, b.x + b.w, b.y + b.h, b.x, b.y + b.h].map(v => round(v, 1));

// ---------- value normalisation ----------
function parseNumber(raw, fix, integer) {
  let t = String(raw).replace(/GBP|USD|EUR|[£$€%\s,]/g, '');
  let corrected = false;
  if (/[OoIl]/.test(t) && /\d/.test(t)) {
    if (!fix) return { ok: false, why: `"${raw}" contains letters where digits belong (O for 0, l for 1)` };
    t = t.replace(/[Oo]/g, '0').replace(/[Il]/g, '1'); corrected = true;
  }
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { ok: false, why: `"${raw}" is not a number` };
  const v = Number(t) * (neg ? -1 : 1);
  if (integer && !Number.isInteger(v)) return { ok: false, why: `"${raw}" is not a whole number` };
  return { ok: true, v, display: integer ? String(v) : v.toFixed(2), corrected };
}
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function parseDate(raw, fmt) {
  const t = String(raw).trim();
  let y, m, d;
  let mm = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mm) [y, m, d] = [+mm[1], +mm[2], +mm[3]];
  else if ((mm = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    y = +mm[3];
    if (fmt === 'MDY') { m = +mm[1]; d = +mm[2]; } else { d = +mm[1]; m = +mm[2]; }
  } else return { ok: false, why: `"${t}" is not a date` };
  if (m < 1 || m > 12) return { ok: false, why: `"${t}" has month ${m} when read as ${fmt === 'MDY' ? 'month-first' : 'day-first'}` };
  if (d < 1 || d > DAYS[m - 1]) return { ok: false, why: `"${t}" has an impossible day` };
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { ok: true, v: iso, display: iso, reinterpreted: iso !== t };
}

// LLM fabrication when a non-nullable field has nothing to support it (deterministic stand-ins).
function fabricate(field, doc) {
  if (field.type === 'date') return '2026-10-31';
  if (field.type === 'number' || field.type === 'integer') return '100.00';
  if (field.type === 'enum') return field.options[0];
  return `${doc.kind === 'receipt' ? 'RCPT' : 'DOC'}-0001`;
}

// ---------- the simulator ----------
function analyze(p) {
  const doc = DOCS[p.document] || DOCS.invoice;
  const approach = APPROACHES[p.approach] ? p.approach : 'prebuilt';
  const A = APPROACHES[approach];
  const r = rng(`${p.document}|${approach}|${p.schema}|${p.normalize}|${p.dateFormat}`);
  const th = p.threshold;
  const steps = [];
  const schema = parseSchema(p.schema);
  const view = { page: { w: 210, h: 297, items: doc.items }, quality: doc.quality, docLabel: doc.label, docKind: doc.kind, approach, threshold: th, policy: p.policy,
    schema, fields: [], rules: [], route: null, received: RECEIVED };

  // 1. Schema
  const schemaJson = schemaArtifact(schema, approach);
  if (!schema.ok) {
    const e = schema.error;
    steps.push(step('schema', `Schema invalid (line ${e.n})`, `${e.msg}${e.text ? ` Line ${e.n}: "${e.text.trim()}".` : ''} Nothing is extracted until the schema parses.`, { line: e.n, text: e.text, error: e.msg }, 'error'));
    return { steps, view, output: [{ type: 'alert', tone: 'error', text: `Schema error on line ${e.n}: ${e.msg} Expected: Name: type [required] [extract|generate|classify] [# description].` }], metrics: [], summary: `Schema error (line ${e.n})` };
  }
  const nonPrebuilt = approach === 'prebuilt' ? schema.fields.filter(f => !PREBUILT[f.name]) : [];
  steps.push(step('schema', `Schema: ${schema.fields.length} field(s), ${schema.fields.filter(f => f.required).length} required`,
    approach === 'prebuilt'
      ? `prebuilt-invoice has a fixed field set; your schema only maps its output.${nonPrebuilt.length ? ` ${nonPrebuilt.map(f => f.name).join(', ')} ${nonPrebuilt.length > 1 ? 'are' : 'is'} not prebuilt-invoice field name(s), so ${nonPrebuilt.length > 1 ? 'they' : 'it'} will come back empty.` : ' Every name matches a prebuilt field.'}`
      : approach === 'cu'
        ? 'The schema becomes the analyzer\'s fieldSchema. Names and descriptions steer what each field extracts; method is extract, generate or classify.'
        : 'The schema becomes a strict json_schema response format. Required fields are non-nullable; optional ones allow null.',
    schemaJson, nonPrebuilt.some(f => f.required) ? 'warn' : 'ok'));

  // 2. Locate evidence
  const order = (a, b) => a.y - b.y || a.x - b.x;
  for (const f of schema.fields) {
    const F = { name: f.name, type: f.type, options: f.options, required: f.required, method: f.method, desc: f.desc, concept: null, resolvedBy: '',
      candidates: [], evidence: null, grounding: 'none', raw: null, value: null, conf: null, status: 'pending', status0: 'pending', notes: [], corrected: false, fabricated: false, ambiguous: false, generated: false, ruleFails: [] };
    view.fields.push(F);
    // generate / classify (not supported by prebuilt-invoice)
    if (f.method !== 'extract' && approach === 'prebuilt') { F.resolvedBy = `prebuilt-invoice cannot ${f.method} custom fields`; F.notes.push(F.resolvedBy + '.'); continue; }
    if (f.method === 'generate') {
      F.generated = true; F.raw = doc.summary; F.resolvedBy = 'generated from the whole document';
      F.notes.push('Generated values are written by the model from the document as a whole, so there is no single source region to point at.');
      continue;
    }
    if (f.method === 'classify') {
      F.resolvedBy = 'classified from the whole document';
      const hit = f.options.find(o => norm(o) === norm(doc.kind));
      F.raw = hit || f.options[f.options.length - 1];
      F.classConf = hit ? 0.93 : 0.48;
      F.notes.push(hit ? `Document looks like a ${doc.kind}.` : `None of the categories fit a ${doc.kind}; the closest option was chosen with low confidence.`);
      continue;
    }
    const res = resolve(f, approach);
    F.resolvedBy = res.how;
    const group = res.concepts.length ? CONCEPTS[res.concepts[0]].group : (f.type === 'date' ? 'date' : f.type === 'number' || f.type === 'integer' ? 'amount' : null);
    // everything of the same kind on the page is "considered"; the field's concept(s) decide what matches
    const considered = [];
    for (const [c, list] of Object.entries(doc.facts)) {
      if (!group || CONCEPTS[c].group !== group) continue;
      for (const fact of list) considered.push({ concept: c, conceptLabel: CONCEPTS[c].label, item: fact.item, text: fact.span, read: fact.read || fact.span, context: doc.items.find(i => i.id === fact.item).text, box: spanBox(doc, fact), baseConf: fact.conf, match: res.concepts.includes(c), chosen: false, currency: fact.currency });
    }
    considered.sort((a, b) => order(a.box, b.box));
    F.candidates = considered;
    const matches = considered.filter(c => c.match);
    if (!matches.length) {
      F.notes.push(res.concepts.length ? `No ${res.concepts.map(c => CONCEPTS[c].label).join(' / ')} on this page.` : `Field ${res.how}.`);
      continue;
    }
    const pick = matches[0];
    pick.chosen = true;
    F.concept = pick.concept;
    F.evidence = pick.box;
    F.raw = pick.read;
    F.currency = pick.currency;
    F.grounding = approach === 'llm' ? 'posthoc' : 'region';
    if (matches.length > 1) {
      F.ambiguous = true;
      F.notes.push(`${matches.length} regions match ${res.how}: ${matches.map(m => `"${m.text}" (${m.conceptLabel})`).join(', ')}. The first in reading order was used${approach === 'llm' ? ', silently: the model does not report ambiguity' : ''}. A specific name or a description fixes this.`);
    }
    let conf = pick.baseConf - (approach === 'prebuilt' ? KIND_PENALTY[doc.kind] || 0 : 0) - (approach === 'cu' && matches.length > 1 ? 0.12 * (matches.length - 1) : 0) + (r() - 0.5) * 0.03;
    F.conf = approach === 'llm' ? null : clamp(round(conf, 2), 0.05, 0.99);
  }
  // LLM: a non-nullable field with no evidence is filled in anyway
  if (approach === 'llm') for (const F of view.fields) {
    if (F.raw == null && F.required && F.method === 'extract') {
      F.raw = fabricate(F, doc); F.fabricated = true; F.grounding = 'none';
      F.notes.push('The schema makes this field non-nullable, so the model had to return something. No text on the page supports it.');
    }
  }
  const missingReq = view.fields.filter(F => F.raw == null && F.required);
  const missingOpt = view.fields.filter(F => F.raw == null && !F.required);
  const ambiguous = view.fields.filter(F => F.ambiguous);
  steps.push(step('locate', `Evidence located for ${view.fields.filter(F => F.evidence).length}/${view.fields.length} field(s)`,
    [
      approach === 'llm' ? 'The model reads the OCR text, not the page; regions are found afterwards by matching each value back to the text (post-hoc grounding).' : `Each field is matched to a region on the page (boundingRegions${approach === 'cu' ? ' / source' : ''}).`,
      missingReq.length ? `Required but not found: ${missingReq.map(F => F.name).join(', ')}.` : '',
      missingOpt.length ? `Optional, not found: ${missingOpt.map(F => F.name).join(', ')}.` : '',
      ambiguous.length ? `Ambiguous: ${ambiguous.map(F => F.name).join(', ')} matched more than one region.` : '',
      view.fields.some(F => F.fabricated) ? `No evidence, but the model returned a value anyway: ${view.fields.filter(F => F.fabricated).map(F => F.name).join(', ')}.` : '',
    ].filter(Boolean).join(' '),
    { fields: view.fields.map(F => ({ field: F.name, resolvedBy: F.resolvedBy, candidates: F.candidates.filter(c => c.match).map(c => c.text), chosen: F.candidates.find(c => c.chosen)?.text ?? null })) },
    missingReq.length || ambiguous.length || view.fields.some(F => F.fabricated) ? 'warn' : 'ok'));

  // 3. Extract: normalise to types, score confidence
  const fix = p.normalize || approach === 'llm';
  for (const F of view.fields) {
    if (F.raw == null) { F.status0 = F.required ? 'missing' : 'empty'; continue; }
    if (F.type === 'enum') { F.value = F.raw; F.ok = true; F.conf = approach === 'llm' ? null : F.classConf; }
    else if (F.type === 'string') { F.value = F.raw; F.ok = true; }
    else if (F.type === 'number' || F.type === 'integer') {
      const n = parseNumber(F.raw, fix, F.type === 'integer');
      if (n.ok) { F.value = n.display; F.num = n.v; F.ok = true; if (n.corrected) { F.corrected = true; F.notes.push(`Read as "${F.raw}"; lookalike characters were normalised to ${n.display}${approach === 'llm' ? ' by the model' : ''}.`); if (F.conf != null) F.conf = round(F.conf - 0.03, 2); } }
      else { F.ok = false; F.notes.push(n.why + '.'); }
    } else if (F.type === 'date') {
      const d = parseDate(F.raw, p.dateFormat);
      if (d.ok) { F.value = d.display; F.iso = d.v; F.ok = true; if (d.reinterpreted) F.notes.push(`"${F.raw}" read as ${p.dateFormat === 'MDY' ? 'month-first' : 'day-first'}: ${d.v}.`); }
      else { F.ok = false; F.notes.push(d.why + '.'); }
    }
    if (F.generated) F.status0 = 'generated';
    else if (F.fabricated) F.status0 = 'unsupported';
    else if (!F.ok) F.status0 = 'malformed';
    else if (F.conf != null && F.conf < th) F.status0 = 'low';
    else F.status0 = 'ok';
  }
  const low = view.fields.filter(F => F.status0 === 'low');
  const malformed = view.fields.filter(F => F.status0 === 'malformed');
  const unsupported = view.fields.filter(F => F.status0 === 'unsupported');
  steps.push(step('extract', `Values normalised: ${view.fields.filter(F => F.status0 === 'ok' || F.status0 === 'generated').length} clean, ${low.length} low-confidence, ${malformed.length} malformed`,
    [
      approach === 'llm' ? 'Structured outputs return no per-field confidence, so the threshold cannot be applied: every value is "unscored".' : `Threshold ${th}: values below it are low confidence.`,
      malformed.length ? `Cannot convert to the schema type: ${malformed.map(F => `${F.name} ("${F.raw}")`).join(', ')}.` : '',
      unsupported.length ? `Unsupported by the page: ${unsupported.map(F => F.name).join(', ')}.` : '',
      view.fields.some(F => F.corrected) ? `Lookalike characters corrected in ${view.fields.filter(F => F.corrected).map(F => F.name).join(', ')}.` : '',
    ].filter(Boolean).join(' '),
    fieldsArtifact(view.fields, approach, doc),
    low.length || malformed.length || unsupported.length ? 'warn' : 'ok'));

  // 4. Validate
  const roleField = role => view.fields.find(F => F.method === 'extract' && (F.concept === role || resolve(F, approach).concepts.includes(role)));
  const rules = [];
  // types
  rules.push(p.ruleTypes
    ? (malformed.length ? { id: 'types', label: 'Values match their types', status: 'fail', fields: malformed.map(F => F.name), detail: malformed.map(F => `${F.name}: "${F.raw}" is not a ${F.type}`).join('; ') }
      : { id: 'types', label: 'Values match their types', status: 'pass', fields: [], detail: 'Every value converted to its schema type.' })
    : { id: 'types', label: 'Values match their types', status: 'off', fields: [], detail: 'Rule disabled.' });
  // required
  rules.push(p.ruleRequired
    ? (missingReq.length ? { id: 'required', label: 'Required fields present', status: 'fail', fields: missingReq.map(F => F.name), detail: `Missing: ${missingReq.map(F => F.name).join(', ')}` }
      : { id: 'required', label: 'Required fields present', status: 'pass', fields: [], detail: view.fields.some(F => F.fabricated) ? 'All present (but some values were fabricated: presence is not proof).' : 'All required fields have a value.' })
    : { id: 'required', label: 'Required fields present', status: 'off', fields: [], detail: 'Rule disabled.' });
  // arithmetic
  if (!p.ruleArithmetic) rules.push({ id: 'arith', label: 'Subtotal + tax = total', status: 'off', fields: [], detail: 'Rule disabled.' });
  else {
    const S = roleField('subtotal'), T = roleField('tax'), G = roleField('total');
    if (!S || !T || !G) rules.push({ id: 'arith', label: 'Subtotal + tax = total', status: 'skip', fields: [], detail: `Schema has no ${[!S && 'subtotal', !T && 'tax', !G && 'total'].filter(Boolean).join(', ')} field to check.` });
    else if (S.num == null || T.num == null || G.num == null) rules.push({ id: 'arith', label: 'Subtotal + tax = total', status: 'skip', fields: [], detail: `Cannot check: ${[S, T, G].filter(F => F.num == null).map(F => F.name).join(', ')} has no numeric value.` });
    else {
      const sum = round(S.num + T.num, 2);
      const ok = Math.abs(sum - G.num) < 0.011;
      rules.push({ id: 'arith', label: 'Subtotal + tax = total', status: ok ? 'pass' : 'fail', fields: ok ? [] : [S.name, T.name, G.name],
        detail: `${S.name} ${S.num.toFixed(2)} + ${T.name} ${T.num.toFixed(2)} = ${sum.toFixed(2)} ${ok ? '=' : '≠'} ${G.name} ${G.num.toFixed(2)}`,
        calc: { a: S.num, b: T.num, sum, total: G.num, names: [S.name, T.name, G.name] } });
    }
  }
  // dates
  if (!p.ruleDates) rules.push({ id: 'dates', label: 'Dates are plausible', status: 'off', fields: [], detail: 'Rule disabled.' });
  else {
    const ds = view.fields.filter(F => F.type === 'date' && F.iso);
    if (!ds.length) rules.push({ id: 'dates', label: 'Dates are plausible', status: 'skip', fields: [], detail: 'No parsed date fields to check.' });
    else {
      const bad = [];
      const why = [];
      for (const F of ds) if (F.iso > RECEIVED) { bad.push(F.name); why.push(`${F.name} ${F.iso} is after the received date ${RECEIVED}`); }
      const I = roleField('issueDate'), D = roleField('dueDate');
      const issueish = I && I.iso ? I : view.fields.find(F => F.type === 'date' && F.iso && F.concept && F.concept !== 'dueDate');
      if (D && D.iso && issueish && issueish !== D && D.iso < issueish.iso) { bad.push(D.name, issueish.name); why.push(`${D.name} ${D.iso} is before ${issueish.name} ${issueish.iso}`); }
      rules.push(bad.length ? { id: 'dates', label: 'Dates are plausible', status: 'fail', fields: [...new Set(bad)], detail: why.join('; ') }
        : { id: 'dates', label: 'Dates are plausible', status: 'pass', fields: [], detail: `${ds.length} date(s) on or before ${RECEIVED}${D && D.iso && issueish ? ', due date after issue date' : ''}.` });
    }
  }
  view.rules = rules;
  for (const R of rules) if (R.status === 'fail') for (const n of R.fields) { const F = view.fields.find(x => x.name === n); if (F) F.ruleFails.push(R.id); }
  // final status after validation
  for (const F of view.fields) {
    F.status = F.status0;
    if (F.ruleFails.length && (F.status0 === 'ok' || F.status0 === 'low') && !F.ruleFails.every(id => id === 'types' || id === 'required')) F.status = 'rule';
  }
  const failed = rules.filter(R => R.status === 'fail');
  const allOff = rules.every(R => R.status === 'off');
  steps.push(step('validate', allOff ? 'No validation rules enabled' : failed.length ? `${failed.length} rule(s) failed` : 'All enabled rules pass',
    allOff ? 'Nothing checks the values before they are used downstream.' : rules.map(R => `${R.label}: ${R.status}${R.status === 'fail' || R.id === 'arith' ? ` (${R.detail})` : ''}`).join('. ') + '.',
    { rules: rules.map(R => ({ rule: R.id, status: R.status, detail: R.detail })) },
    failed.length || allOff ? 'warn' : 'ok'));

  // 5. Route
  const isProblem = F => ['missing', 'malformed', 'unsupported', 'low', 'rule'].includes(F.status);
  const flagged = view.fields.filter(F =>
    F.status === 'low' || F.status === 'unsupported' || F.status === 'rule' ||
    (F.status === 'malformed' && p.ruleTypes) || (F.status === 'missing' && p.ruleRequired));
  const reqCount = view.fields.filter(F => F.required).length;
  let route;
  if (p.policy === 'auto' || !flagged.length) {
    const bad = view.fields.filter(isProblem);
    route = { decision: 'approved', queue: [], posted: bad.map(F => F.name) };
    if (bad.length) steps.push(step('route', 'Auto-approved with bad data', `${p.policy === 'auto' ? 'Policy auto-approves everything, so' : 'No rule flagged them, so'} ${bad.map(F => `${F.name} (${F.status})`).join(', ')} went straight to the ERP. In this simulation the posting is rejected or, worse, wrong values are stored.`, { decision: 'approved', unverified: bad.map(F => F.name) }, 'error'));
    else steps.push(step('route', 'Auto-approved', 'Every field is grounded, above threshold and passes the enabled rules. The record is posted with no human touch (straight-through processing).', { decision: 'approved', fields: view.fields.length }, 'ok'));
  } else if (reqCount && missingReq.length >= Math.max(2, reqCount / 2)) {
    route = { decision: 'rejected', queue: [] };
    steps.push(step('route', 'Rejected: wrong document type for this schema', `${missingReq.length} of ${reqCount} required fields are missing. This is probably not a ${doc.kind === 'invoice' ? 'document this schema was written for' : 'an invoice'}; send it back to classification instead of asking a reviewer to type it all in.`, { decision: 'rejected', missingRequired: missingReq.map(F => F.name) }, 'warn'));
  } else {
    const queue = p.policy === 'doc' ? view.fields.map(F => F.name) : flagged.map(F => F.name);
    route = { decision: 'review', queue };
    steps.push(step('route', p.policy === 'doc' ? 'Whole document sent to review' : `${flagged.length} field(s) sent to review`,
      `${flagged.map(F => `${F.name}: ${F.status === 'rule' ? 'failed ' + F.ruleFails.join('/') : F.status}`).join('; ')}. ${p.policy === 'doc' ? 'Policy: any flag puts the whole document in the queue.' : 'Clean fields are kept; a reviewer only checks the flagged ones.'}`,
      { decision: 'review', queue }, 'info'));
  }
  view.route = route;

  // ---------- outputs ----------
  const scored = view.fields.filter(F => F.conf != null);
  const meanConf = scored.length ? scored.reduce((a, F) => a + F.conf, 0) / scored.length : null;
  const grounded = view.fields.filter(F => F.evidence).length;
  const enabled = rules.filter(R => R.status !== 'off');
  const passed = rules.filter(R => R.status === 'pass').length;
  const tone = F => (F.status === 'ok' || F.status === 'generated' ? 'ok' : F.status === 'empty' ? 'muted' : F.status === 'low' || F.status === 'rule' ? 'warn' : 'error');
  const record = Object.fromEntries(view.fields.map(F => [F.name, F.value ?? null]));
  return {
    steps, view,
    output: [
      { type: 'alert', tone: route.decision === 'approved' ? (steps[steps.length - 1].status === 'error' ? 'error' : 'ok') : route.decision === 'review' ? 'info' : 'warn',
        text: route.decision === 'approved' ? (steps[steps.length - 1].status === 'error' ? `Posted without review, including unverified values: ${route.posted.join(', ')}.` : 'Straight-through: the record was approved automatically.')
          : route.decision === 'review' ? `Review queue: ${route.queue.join(', ')}. Open the queue in the workbench to approve or correct each value.` : 'Rejected: most required fields are missing. Route the document back to classification.' },
      { type: 'table', title: 'Extracted fields', columns: ['Field', 'Type', 'Value', 'Confidence', 'Evidence', 'Status'],
        rows: view.fields.map(F => [F.name + (F.required ? ' *' : ''), F.type, F.value ?? (F.raw ? `“${F.raw}”` : '—'), F.conf == null ? (F.raw == null ? '—' : 'unscored') : F.conf.toFixed(2), F.evidence ? (F.grounding === 'posthoc' ? `matched text “${F.candidates.find(c => c.chosen).text}”` : `region “${F.candidates.find(c => c.chosen).text}”`) : F.generated ? 'generated' : F.type === 'enum' && F.raw ? 'whole document' : 'none', F.status]),
        tones: view.fields.map(tone) },
      { type: 'json', title: `Record handed downstream (${A.short}, simulated)`, data: record },
    ],
    metrics: [
      metric('Fields with a value', `${view.fields.filter(F => F.value != null).length}/${view.fields.length}`, 'computed'),
      metric('Fields grounded to a region', `${grounded}/${view.fields.length}`, 'computed', approach === 'llm' ? 'LLM values are grounded after the fact by text matching.' : 'Values with a bounding region on the page.'),
      metric('Mean confidence', meanConf == null ? 'n/a' : meanConf.toFixed(2), 'computed', meanConf == null ? 'No confidence scores with this approach.' : 'Average simulated field confidence.'),
      metric('Rules passed', `${passed}/${enabled.length}`, 'computed', 'Skipped rules count as not passed.'),
      metric('Fields needing review', String(route.decision === 'review' ? route.queue.length : 0), 'computed'),
      metric('Straight-through', route.decision === 'approved' && steps[steps.length - 1].status === 'ok' ? 'yes' : 'no', 'computed', 'Approved with no human touch and no bad data.'),
    ],
    summary: `${doc.label} · ${A.short} · ${grounded}/${view.fields.length} grounded · ${route.decision}${route.decision === 'review' ? ` (${route.queue.length})` : ''}`,
  };
}

// What the schema turns into for each approach (shapes are illustrative; check the API version you use).
function schemaArtifact(schema, approach) {
  if (!schema.ok) return null;
  if (approach === 'prebuilt') return { modelId: 'prebuilt-invoice', mapping: Object.fromEntries(schema.fields.map(f => [f.name, PREBUILT[f.name] ? `documents[0].fields.${f.name}` : 'not returned by this model'])) };
  if (approach === 'cu') return { analyzerId: 'invoice-fields', baseAnalyzerId: 'prebuilt-document', config: { returnDetails: true, estimateFieldSourceAndConfidence: true },
    fieldSchema: { fields: Object.fromEntries(schema.fields.map(f => [f.name, { type: f.type === 'enum' ? 'string' : f.type, method: f.method, ...(f.options ? { enum: f.options } : {}), ...(f.desc ? { description: f.desc } : {}) }])) } };
  const jt = f => (f.type === 'number' ? 'number' : f.type === 'integer' ? 'integer' : 'string');
  return { response_format: { type: 'json_schema', json_schema: { name: 'extraction', strict: true, schema: { type: 'object', additionalProperties: false, required: schema.fields.map(f => f.name),
    properties: Object.fromEntries(schema.fields.map(f => [f.name, { type: f.required ? jt(f) : [jt(f), 'null'], ...(f.options ? { enum: f.options } : {}), ...(f.type === 'date' ? { description: 'ISO date YYYY-MM-DD' } : f.desc ? { description: f.desc } : {}) }])) } } } };
}
function fieldsArtifact(fields, approach, doc) {
  const shape = F => {
    if (F.raw == null) return null;
    const base = F.type === 'number' ? (approach === 'prebuilt' && /Total|Tax/.test(F.name) ? { type: 'currency', valueCurrency: F.num != null ? { amount: F.num, currencyCode: F.currency || 'GBP' } : null } : { type: 'number', valueNumber: F.num ?? null })
      : F.type === 'date' ? { type: 'date', valueDate: F.iso ?? null } : { type: 'string', valueString: F.value };
    const where = F.evidence ? (approach === 'prebuilt' ? { boundingRegions: [{ pageNumber: 1, polygon: polygon(F.evidence) }] } : approach === 'cu' ? { source: `D(1,${polygon(F.evidence).join(',')})` } : {}) : {};
    return { ...base, content: F.raw, ...(F.conf != null ? { confidence: F.conf } : {}), ...where };
  };
  if (approach === 'prebuilt') return { modelId: 'prebuilt-invoice', documents: [{ docType: 'invoice', fields: Object.fromEntries(fields.map(F => [F.name, shape(F)])) }], note: 'Polygons are in this lab\'s page units, not inches.' };
  if (approach === 'cu') return { result: { analyzerId: 'invoice-fields', contents: [{ kind: 'document', fields: Object.fromEntries(fields.map(F => [F.name, shape(F)])) }] }, note: 'Illustrative shape; check the Content Understanding API version you target.' };
  return { message: { content: JSON.stringify(Object.fromEntries(fields.map(F => [F.name, F.value ?? (F.raw != null ? F.raw : null)]))) }, grounding: 'computed afterwards by matching values to OCR text' };
}

const fieldsSchema = lines => lines.join('\n');

export default {
  id: 'fields',
  lab: 'Field extraction studio',
  workbench: 'fields',
  services: [
    { name: 'Document Intelligence: invoice model', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/invoice' },
    { name: 'Content Understanding: analyzer field schema', url: 'https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/' },
    { name: 'Azure OpenAI: structured outputs', url: 'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs' },
    { name: 'Document Intelligence: accuracy and confidence scores', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/accuracy-confidence' },
  ],
  prereqs: ['ingestion'],
  next: ['classification', 'multimodal'],

  concept: {
    plain: 'Reading a document is not enough: a finance system needs specific values, such as who sent the invoice, its number, its date and its total, each in the right format. Field extraction fills in a form you define (the schema), points to exactly where on the page each value came from, says how sure it is, checks the values make sense together, and sends anything doubtful to a person instead of guessing.',
    technical: 'Document Intelligence prebuilt-invoice returns a fixed set of typed fields (VendorName, InvoiceId, InvoiceDate, DueDate, SubTotal, TotalTax, InvoiceTotal, …), each with content, a typed value, a confidence score and boundingRegions (page + polygon). Content Understanding lets you define your own analyzer fieldSchema: each field has a type, a description and a method (extract = grounded in the content, generate = written by the model, classify = one of a set of categories), and can return source locations and confidence. An LLM with a json_schema response format (structured outputs) guarantees the JSON shape, not the correctness of values, and gives no per-field confidence or location. In every case you add validation rules and a confidence threshold that route uncertain fields to human review.',
    useCase: 'An accounts-payable team receives invoices, receipts and purchase orders by email. Clean supplier invoices flow straight into the ERP. Scans with smudged digits, handwritten totals or two different dates are caught by type checks, arithmetic checks and confidence thresholds, and land in a review queue where a clerk sees the highlighted source region next to the value and approves or corrects it in seconds.',
    terms: [
      ['Field schema', 'The list of fields you want, each with a name, type, whether it is required and (in Content Understanding) a description and method.'],
      ['Grounding / evidence', 'The link from a value to the region of the page it came from (boundingRegions or source). Lets a reviewer verify a value at a glance.'],
      ['Confidence threshold', 'The score below which a value is not trusted automatically. Set per field from measured accuracy, not by guesswork.'],
      ['Validation rule', 'A business check on extracted values: types, required fields, arithmetic (subtotal + tax = total), date sanity.'],
      ['Human-in-the-loop review', 'A queue where people approve or correct flagged values; their corrections can also become labelled training data.'],
      ['Structured outputs', 'An LLM response format that forces JSON matching a schema. Shape is guaranteed; truth is not.'],
    ],
  },

  visual: {
    views: {
      conceptual: () => ({
        nodes: [
          { id: 'schema', label: 'Field schema', col: 0, row: 1, detail: 'What you want back: names, types, required flags, descriptions and (in Content Understanding) a method per field.', substeps: ['Parse names and types', 'Required vs optional', 'Descriptions steer meaning'] },
          { id: 'locate', label: 'Locate evidence', col: 1, row: 1, detail: 'Find the region of the page that holds each value. Vague names match several regions; specific names or descriptions pick one.', substeps: ['Candidate regions', 'Pick best match', 'Record bounding region'] },
          { id: 'extract', label: 'Extract & normalise', col: 2, row: 1, detail: 'Convert the text into typed values (number, date) and score confidence. Lookalike characters and date formats bite here.', substeps: ['Type conversion', 'Lookalike fixes', 'Confidence vs threshold'] },
          { id: 'validate', label: 'Validate', col: 3, row: 1, detail: 'Business rules over the whole record: types, required fields, subtotal + tax = total, plausible dates.', substeps: ['Types', 'Required', 'Arithmetic', 'Date sanity'] },
          { id: 'route', label: 'Route', col: 4, row: 1, detail: 'Auto-approve clean records, queue flagged fields for a human, reject documents that do not fit the schema.', substeps: ['Auto-approve', 'Review queue', 'Reject / reclassify'] },
          { id: 'review', label: 'Human review', col: 4, row: 2.4, kind: 'user', detail: 'A reviewer sees the value next to its highlighted source region and approves or corrects it.' },
        ],
        edges: [['schema', 'locate'], ['locate', 'extract'], ['extract', 'validate'], ['validate', 'route'], ['route', 'review', 'flagged']],
      }),
      architectural: p => {
        const ap = p ? p.approach : 'prebuilt';
        return {
          nodes: [
            { id: 'schema', label: 'Blob Storage (inbox)', col: 0, row: 1, kind: 'store', detail: 'Documents land in a container; an event triggers processing. The schema lives in source control next to the pipeline code.' },
            { id: 'locate', label: ap === 'prebuilt' ? 'Document Intelligence · prebuilt-invoice' : ap === 'cu' ? 'Content Understanding · custom analyzer' : 'Azure OpenAI model in Foundry (+ layout OCR)', col: 1, row: 1, kind: 'ai',
              detail: ap === 'prebuilt' ? 'Fixed invoice schema with confidence and bounding regions per field.' : ap === 'cu' ? 'Your fieldSchema (extract / generate / classify) with source and confidence estimates.' : 'OCR text is sent with a json_schema response format. No per-field confidence or regions come back.',
              badge: p ? APPROACHES[ap].short : null },
            { id: 'extract', label: 'Azure Function: normalise', col: 2, row: 1, kind: 'compute', detail: 'Converts strings to typed values, fixes known OCR lookalikes in numeric fields, applies the date format of the sender.' },
            { id: 'validate', label: 'Azure Function: rules', col: 3, row: 1, kind: 'compute', detail: 'Business rules and the confidence threshold decide what can be trusted.' },
            { id: 'route', label: 'Service Bus: approved / review', col: 4, row: 1, kind: 'data', detail: 'Approved records go to the ERP topic; flagged ones go to a review queue.' },
            { id: 'review', label: 'Review app (Power Apps / web)', col: 4, row: 2.4, kind: 'app', detail: 'Shows each flagged value beside its source region. Corrections are saved, and can be reused as labelled data.' },
            { id: 'erp', label: 'ERP / finance system', col: 3, row: 2.4, kind: 'external', detail: 'Receives only validated or reviewed records.' },
          ],
          edges: [['schema', 'locate', 'analyze'], ['locate', 'extract'], ['extract', 'validate'], ['validate', 'route'], ['route', 'review', 'flagged'], ['route', 'erp', 'approved'], ['review', 'erp', 'corrected']],
        };
      },
      implementation: p => {
        const ap = p ? p.approach : 'prebuilt';
        const call = ap === 'prebuilt' ? 'poller = di.begin_analyze_document("prebuilt-invoice", body); doc = poller.result().documents[0]'
          : ap === 'cu' ? 'PUT /contentunderstanding/analyzers/invoice-fields  {fieldSchema: {fields: {...}}}  then POST …:analyze'
            : 'client.chat.completions.create(model=deployment, messages=[…ocr markdown…], response_format={"type": "json_schema", …})';
        return {
          nodes: [
            { id: 'schema', label: ap === 'llm' ? 'schema = {"type": "object", "properties": {…}, "required": [all], "additionalProperties": false}' : ap === 'cu' ? 'fields = {"InvoiceTotal": {"type": "number", "method": "extract", "description": "…"}}' : 'WANTED = ["VendorName", "InvoiceId", "InvoiceDate", "InvoiceTotal", …]', col: 0, row: 0, kind: 'code', detail: ap === 'llm' ? 'Strict mode lists every property as required; optional values are typed ["string", "null"].' : ap === 'cu' ? 'Illustrative fieldSchema; the exact analyzer JSON depends on the API version.' : 'prebuilt-invoice has a fixed schema: you choose which of its fields to use.' },
            { id: 'locate', label: call, col: 0, row: 1, kind: 'code', detail: 'Illustrative; check the SDK / REST reference for your version. Authenticate with DefaultAzureCredential (Microsoft Entra ID).' },
            { id: 'extract', label: ap === 'llm' ? 'rec = json.loads(resp.choices[0].message.content)  # no confidence' : 'f = doc.fields["InvoiceTotal"]; f.value_currency.amount, f.confidence, f.bounding_regions', col: 0, row: 2, kind: 'code', detail: ap === 'llm' ? 'Ground values afterwards by searching the OCR text for them.' : 'Each field carries content, typed value, confidence and its region.' },
            { id: 'validate', label: 'errors = [r for r in RULES if not r(rec)]; low = [k for k, f in fields.items() if f.confidence < THRESHOLDS[k]]', col: 0, row: 3, kind: 'code', detail: 'Rules and per-field thresholds are plain code you own and test.' },
            { id: 'route', label: 'sender.send_messages(ServiceBusMessage(json.dumps(rec)))  # to "approved" or "review"', col: 0, row: 4, kind: 'code', detail: 'azure-servicebus; the review app subscribes to the review queue.' },
          ],
          edges: [['schema', 'locate'], ['locate', 'extract'], ['extract', 'validate'], ['validate', 'route']],
        };
      },
    },
  },

  sim: {
    mode: 'local',
    controls: [
      { id: 'document', label: 'Sample document', type: 'select', options: Object.entries(DOCS).map(([v, d]) => [v, d.label]), default: 'invoice' },
      { id: 'approach', label: 'Extraction approach', type: 'select', options: Object.entries(APPROACHES).map(([v, a]) => [v, a.label]), default: 'cu', help: 'All three are simulated locally. Content Understanding is the service the AI-103 objectives name for analyzers.' },
      { id: 'schema', label: 'Field schema (one per line: Name: type [required] [extract|generate|classify] [# description])', type: 'textarea', default: DEFAULT_SCHEMA },
      { id: 'threshold', label: 'Confidence threshold', type: 'range', min: 0.5, max: 0.95, step: 0.05, default: 0.8 },
      { id: 'normalize', label: 'Fix lookalike characters in numbers (O→0, l→1)', type: 'toggle', default: false },
      { id: 'dateFormat', label: 'Sender date format for dd/dd/yyyy', type: 'select', options: [['DMY', 'Day first (UK: 13/09/2026)'], ['MDY', 'Month first (US: 09/13/2026)']], default: 'DMY' },
      { id: 'ruleTypes', label: 'Rule: values match their types', type: 'toggle', default: true },
      { id: 'ruleRequired', label: 'Rule: required fields present', type: 'toggle', default: true },
      { id: 'ruleArithmetic', label: 'Rule: subtotal + tax = total', type: 'toggle', default: true },
      { id: 'ruleDates', label: 'Rule: dates are plausible', type: 'toggle', default: true },
      { id: 'policy', label: 'Review policy', type: 'select', options: [['field', 'Review only flagged fields'], ['doc', 'Any flag sends the whole document to review'], ['auto', 'Auto-approve everything (no review)']], default: 'field' },
    ],
    samples: [
      { label: 'Clean invoice, prebuilt-invoice', values: { document: 'invoice' } },
      { label: 'Handwritten invoice → review queue', values: { document: 'handwritten' } },
      { label: 'Scanned invoice with smudged digits', values: { document: 'scan' } },
      { label: 'Purchase order with a custom analyzer schema', values: { document: 'po', approach: 'cu', schema: fieldsSchema(['VendorName: string required # the supplier the order is sent to', 'PurchaseOrder: string required', 'OrderDate: date required', 'DeliveryDate: date', 'CostCentre: string required', 'SubTotal: number', 'TotalTax: number', 'InvoiceTotal: number required', 'Summary: string generate # one line: what is being bought', 'DocType: enum(invoice|receipt|purchase order) classify']) } },
      { label: 'Receipt with an LLM and an invoice schema', values: { document: 'receipt', approach: 'llm' } },
    ],
    run: analyze,
  },

  compare: {
    suggestions: [
      'Run the handwritten invoice with prebuilt-invoice, then with the LLM approach. Count the fields in the review queue: the LLM gives no confidence, so the shaky handwritten total is no longer flagged.',
      'Run the scanned invoice with lookalike fixing off, then on. Watch SubTotal go from malformed to 104.50 and the arithmetic rule switch from skipped to passed.',
      'Switch the scanned invoice\'s date format from day-first to month-first and compare which date fields still parse.',
      'With the Content Understanding approach, rename InvoiceDate to just "Date" on the scanned invoice, run, then add "# date the invoice was issued". Compare the chosen evidence region and confidence.',
      'Run the handwritten invoice with "Review only flagged fields", then "Any flag sends the whole document". Compare the queue sizes.',
    ],
  },

  debug: [
    { id: 'syntax', title: 'Nothing is extracted at all', values: { schema: fieldsSchema(['VendorName: string required', 'InvoiceId: string required', 'InvoiceDate: date required', 'InvoiceTotal number required']) }, node: 'schema',
      symptom: 'The run stops at the first stage with a schema error on line 4.', cause: 'A missing colon: "InvoiceTotal number required" is not valid schema syntax.', fix: 'Write it as "InvoiceTotal: number required".' },
    { id: 'lookalike', title: 'Scanned invoice: SubTotal is "malformed" and the arithmetic check is skipped', values: { document: 'scan', normalize: false }, node: 'extract',
      symptom: 'SubTotal shows the raw text "1O4.50" and cannot be converted to a number; the record goes to review.', cause: 'The 200 dpi scan makes 0 look like the letter O. The text is fine for a person, not for a number parser.', fix: 'Turn on "Fix lookalike characters in numbers" (and rescan at 300 dpi where you can).' },
    { id: 'locale', title: 'Invoice dates from a UK supplier are rejected', values: { document: 'scan', normalize: true, dateFormat: 'MDY' }, node: 'extract',
      symptom: 'InvoiceDate "13/09/2026" is malformed: there is no month 13.', cause: 'The sender writes day-first dates but the pipeline parses them month-first.', fix: 'Set the sender date format to day first (better still: keep a per-supplier locale).' },
    { id: 'vague-date', title: 'The custom analyzer picks the order date', values: { document: 'scan', normalize: true, approach: 'cu', schema: fieldsSchema(['VendorName: string required', 'InvoiceId: string required', 'Date: date required', 'InvoiceTotal: number required']) }, node: 'locate',
      symptom: 'Date is 2026-09-11 with low confidence: the order date, not the invoice date.', cause: 'A field called just "Date" matches three dates on the page. Nothing says which one you mean.', fix: 'Rename it InvoiceDate, or add a description such as "# date the invoice was issued".' },
    { id: 'vague-tax', title: 'Arithmetic check fails on a perfectly good invoice', values: { approach: 'cu', schema: fieldsSchema(['VendorName: string required', 'InvoiceId: string required', 'SubTotal: number required', 'Tax: number', 'InvoiceTotal: number required']) }, node: 'validate',
      symptom: '240.00 + 20.00 ≠ 288.00. Every field looks confident.', cause: '"Tax" matched both the VAT rate (20%) and the VAT amount (48.00); the rate came first. The model was confidently wrong and only the arithmetic rule caught it.', fix: 'Rename the field TotalTax or describe it: "Tax: number # VAT amount in currency".' },
    { id: 'auto', title: 'Handwritten invoices post junk to the ERP', values: { document: 'handwritten', policy: 'auto' }, node: 'route',
      symptom: 'The route stage errors: a due date of "TBC" and a low-confidence handwritten total were posted.', cause: 'The review policy auto-approves everything, so flags are ignored.', fix: 'Use "Review only flagged fields" (or whole-document review).' },
    { id: 'fabricated', title: 'Every receipt gets invoice number RCPT-0001', values: { document: 'receipt', approach: 'llm', schema: fieldsSchema(['MerchantName: string required', 'TransactionDate: date required', 'InvoiceId: string required', 'Total: number required']) }, node: 'extract',
      symptom: 'InvoiceId always has a value, but nothing on the receipt supports it. The required rule passes.', cause: 'A required (non-nullable) property in a strict JSON schema forces the model to output something even when the document has no such value.', fix: 'Remove "required" from InvoiceId so it is nullable; the model can then return null.' },
    { id: 'wrong-model', title: 'Cost centre never comes back', values: { document: 'po', approach: 'prebuilt', schema: fieldsSchema(['VendorName: string required', 'PurchaseOrder: string required', 'CostCentre: string required', 'InvoiceTotal: number required']) }, node: 'locate',
      symptom: 'CostCentre is missing although it is printed on the order.', cause: 'prebuilt-invoice has a fixed schema with no cost-centre field. Adding a name to your schema does not teach it a new field.', fix: 'Switch to a Content Understanding custom analyzer (or a custom extraction model) that defines CostCentre.' },
  ],

  challenge: {
    task: 'Get the scanned invoice processed straight-through: no human touch, every field grounded, with a strict confidence threshold of at least 0.85 and all four validation rules switched on.',
    condition: 'Document = scanned invoice, threshold ≥ 0.85, all four rules on, policy is not auto-approve, decision = auto-approved, no error steps.',
    hint: 'Two things on this scan stop it: one character problem and one date problem. Look at what the extract stage reports.',
    check: (p, res) => p.document === 'scan' && p.threshold >= 0.85 && p.ruleTypes && p.ruleRequired && p.ruleArithmetic && p.ruleDates && p.policy !== 'auto'
      && !!res.view && !!res.view.route && res.view.route.decision === 'approved' && !res.steps.some(s => s.status === 'error') && res.view.fields.every(F => F.evidence),
    solution: ['Choose the scanned invoice and raise the threshold to 0.85.', 'Turn on "Fix lookalike characters in numbers" so 1O4.50 becomes 104.50.', 'Keep the date format day-first: 13/09/2026 is 13 September.', 'Keep prebuilt-invoice (or a CU analyzer with specific names) and all rules on.', 'Run: every field is above 0.85, 104.50 + 20.90 = 125.40, dates are plausible, the record is auto-approved.'],
    solutionValues: { document: 'scan', threshold: 0.85, normalize: true, dateFormat: 'DMY', approach: 'prebuilt', policy: 'field' },
  },

  quiz: [
    { q: 'You need VendorName, InvoiceTotal and a company-specific CostCentre from invoices, each with its location on the page. What fits best?', options: ['prebuilt-invoice and add CostCentre to your mapping', 'A Content Understanding analyzer (or custom extraction model) whose field schema includes CostCentre', 'prebuilt-read and a regular expression', 'An LLM with structured outputs, because it returns bounding boxes'], answer: 1, why: 'Prebuilt models have fixed fields. A custom analyzer lets you define CostCentre with a description and still returns source regions and confidence.' },
    { q: 'An LLM with a strict JSON schema returns InvoiceId "RCPT-0001" for receipts that have no invoice number. What is the best fix?', options: ['Raise the temperature', 'Make the property nullable and check that every value can be found in the source text', 'Lower the confidence threshold', 'Add more required fields'], answer: 1, why: 'Structured outputs guarantee shape, not truth. A non-nullable field forces a value; allow null and ground values back to the text.' },
    { q: 'Every field on an invoice is above the 0.8 threshold, but SubTotal 240.00 + Tax 20.00 ≠ Total 288.00. What happened, and what catches it?', options: ['OCR failed; raise the threshold', 'A vague field name matched the VAT rate instead of the amount; the arithmetic rule catches it', 'The total is wrong on the invoice; auto-approve it', 'Confidence scores are always wrong; ignore them'], answer: 1, why: 'High confidence means the model is sure of what it read, not that it read the right region. Cross-field rules catch confident mistakes.' },
    { q: 'Handwritten totals come back at confidence 0.58 with a threshold of 0.8. The business wants zero manual work. What do you do?', options: ['Set the threshold to 0.5', 'Keep the threshold, send those fields to a review queue that shows the source region, and use corrections to measure and improve accuracy', 'Switch to an LLM because it has no confidence scores', 'Drop the total field'], answer: 1, why: 'Thresholds should come from measured accuracy. Low-confidence values go to quick, evidence-backed review; corrections become labelled data.' },
    { q: 'A UK supplier\'s invoice date "13/09/2026" fails type validation. What is the most likely cause?', options: ['The OCR misread the digits', 'The pipeline parses dd/mm dates as month-first', 'Dates are not supported in schemas', 'The confidence threshold is too high'], answer: 1, why: 'Month 13 only exists if the date is read the wrong way round. Store the sender\'s locale and parse accordingly.' },
  ],

  recap: 'Define a schema with specific names (and descriptions where the meaning is ambiguous), insist on evidence for every extracted value, convert to strict types, check the record with cross-field rules, and let confidence plus validation decide what is auto-approved and what a person reviews next to its source region. Structured outputs guarantee shape, not truth.',
};
