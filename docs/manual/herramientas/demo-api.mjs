// Small actions on the demo API (default :3101, database solaluminios_ensayo_manual)
// as one of the demo users of seed-manual.json, to prepare states for screenshots.
//   node demo-api.mjs approve-quote <COT-number>          ADMIN approves its pending requests
//   node demo-api.mjs invoice <OV-number> <invoice-no>     BILLING records an invoice
//   node demo-api.mjs call <userKey> <METHOD> <path> [json]
import { readFileSync } from 'node:fs';

const s = JSON.parse(readFileSync(new URL('./seed-manual.json', import.meta.url)));
const BASE = process.env.DEMO_API ?? 'http://localhost:3101';
const login = async (key) => {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: s.users[key].email, password: s.users[key].password }) });
  if (!res.ok) throw new Error(`login ${key}: ${res.status}`);
  const body = await res.json();
  return body.accessToken ?? body.token ?? body.access_token;
};
const call = async (token, method, path, body) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const [mode, ...args] = process.argv.slice(2);
if (mode === 'approve-quote') {
  const admin = await login('admin');
  const list = await call(admin, 'GET', '/quotes?pageSize=50');
  const quote = (list.items ?? list).find((q) => q.number === args[0]);
  if (!quote) throw new Error('quote not found');
  const full = await call(admin, 'GET', `/quotes/${quote.id}`);
  for (const r of full.discountRequests.filter((x) => x.status === 'PENDING')) {
    const kind = r.kind === 'MANUAL_PRICE' ? 'price-requests' : 'discount-requests';
    await call(admin, 'POST', `/quotes/${quote.id}/${kind}/${r.id}/approve`, kind === 'price-requests' ? {} : undefined);
    console.log('approved', r.kind ?? 'GLOBAL', r.id);
  }
} else if (mode === 'invoice') {
  const token = await login('facturacion');
  const list = await call(token, 'GET', '/sales-orders?pageSize=50');
  const order = (list.items ?? list).find((o) => o.number === args[0]);
  if (!order) throw new Error('order not found');
  const done = await call(token, 'POST', `/sales-orders/${order.id}/invoice`, { invoiceNumber: args[1] });
  console.log('invoiced', done.number ?? order.number, done.invoiceNumber ?? args[1]);
} else if (mode === 'call') {
  const [key, method, path, json] = args;
  const token = await login(key);
  console.log(JSON.stringify(await call(token, method, path, json ? JSON.parse(json) : undefined), null, 1).slice(0, 3000));
} else {
  console.error('Uso: node demo-api.mjs approve-quote|invoice|call ...');
  process.exitCode = 1;
}
