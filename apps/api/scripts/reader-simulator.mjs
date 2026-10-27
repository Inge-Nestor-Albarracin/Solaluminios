// SIMULADOR de lector fijo / portal RFID (fase 2).
//
// Envía observaciones con el MISMO contrato que usará el adaptador del lector
// real: POST /reader/observations, cabeceras X-Reader-Id y
// "Authorization: Reader <secreto>", sesión ligada a un despacho y eventos
// { eventId, epc, observedAt, antenna, rssi }. La sesión la abre una persona
// desde la pantalla del despacho; sin --session se usa la sesión abierta del
// lector. Sirve para probar reglas,
// incidencias y deduplicación; NO prueba cobertura, dirección de paso,
// interferencias ni lectura real de radio.
//
// Requisitos: API con READER_CAPTURE_ENABLED=true, un lector registrado en
// Administración → Lectores fijos (marcado como simulador) y una sesión
// abierta para un despacho (Despacho → «Lector fijo / portal» → Abrir sesión).
// El secreto se lee de la variable READER_SECRET
// (nunca como argumento, para que no quede en el historial).
//
// Uso (desde apps/api):
//   $env:READER_SECRET='<secreto>'
//   node scripts/reader-simulator.mjs --api http://localhost:3000 --reader SIM-01 \
//     --epcs E2801170...,E2801170... --repeat 20 --batch 50 [--session <id>] [--resend]
//
// --repeat N simula N detecciones de radio por chip (un chip quieto cerca de
// la antena se lee muchas veces); --resend reenvía el mismo lote para
// comprobar que el servidor ignora eventos repetidos.
import { randomUUID } from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? 'true' : all[index + 1]]);
    return pairs;
  }, []),
);
const api = (args.api ?? 'http://localhost:3000').replace(/\/+$/, '');
const reader = args.reader;
const session = args.session;
const secret = process.env.READER_SECRET;
const epcs = (args.epcs ?? '').split(',').map((e) => e.trim().toUpperCase()).filter(Boolean);
const repeat = Math.max(1, Number(args.repeat ?? 1));
const batchSize = Math.min(500, Math.max(1, Number(args.batch ?? 100)));

if (!reader || !secret || epcs.length === 0) {
  console.error('Faltan datos: --reader, --epcs y la variable READER_SECRET.');
  process.exit(1);
}

const now = Date.now();
const events = epcs.flatMap((epc) =>
  Array.from({ length: repeat }, (_, i) => ({
    eventId: randomUUID(),
    epc,
    observedAt: new Date(now - (repeat - i) * 50).toISOString(),
    antenna: 1 + (i % 4),
    rssi: -40 - Math.floor(Math.random() * 30),
  })),
);

async function send(batch) {
  const res = await fetch(`${api}/reader/observations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Reader-Id': reader, Authorization: `Reader ${secret}` },
    body: JSON.stringify(session ? { sessionId: session, events: batch } : { events: batch }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

console.log(`[SIMULADOR] ${events.length} detecciones de ${epcs.length} chip(s) hacia ${api} (lector ${reader}).`);
for (let i = 0; i < events.length; i += batchSize) {
  const { status, body } = await send(events.slice(i, i + batchSize));
  console.log(`[SIMULADOR] lote ${i / batchSize + 1}: HTTP ${status}`, JSON.stringify(body));
  if (status >= 400) process.exit(2);
}
if (args.resend === 'true') {
  const { status, body } = await send(events.slice(0, batchSize));
  console.log(`[SIMULADOR] reenvío del primer lote (deben ser duplicados): HTTP ${status}`, JSON.stringify(body));
}
