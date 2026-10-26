// Generates the VAPID keys for Web Push and appends them to apps/api/.env
// (or the file given as first argument) if they are not configured yet.
// The private key is never printed. Usage (from apps/api):
//   node scripts/Configure-Vapid.mjs [archivo.env] [mailto:correo@empresa.com]
// Generate them ONCE per environment: new keys invalidate every existing
// browser subscription (users must activate notifications again).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import webpush from 'web-push';

const file = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../.env', import.meta.url));
const subject = process.argv[3] ?? 'mailto:soporte@solaluminios.local';
if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject)) {
  throw new Error('VAPID_SUBJECT debe ser mailto:correo o una URL https://');
}

const content = existsSync(file) ? readFileSync(file, 'utf8') : '';
const vars = parse(content);
// Empty placeholders (copied from .env.example) count as not configured.
const present = ['VAPID_SUBJECT', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'].filter((name) => vars[name]?.trim());
if (present.length === 3) {
  console.log('Las claves VAPID ya estaban configuradas; no se modificaron.');
} else if (present.length > 0) {
  throw new Error(`Configuración VAPID incompleta (${present.join(', ')}). Corrígela a mano antes de continuar.`);
} else {
  const keys = webpush.generateVAPIDKeys();
  const kept = content.replace(/^VAPID_(SUBJECT|PUBLIC_KEY|PRIVATE_KEY)=[ \t]*\r?\n?/gm, '');
  const separator = kept && !kept.endsWith('\n') ? '\n' : '';
  writeFileSync(
    file,
    `${kept}${separator}\n# Web Push (VAPID). La clave privada no debe compartirse.\nVAPID_SUBJECT=${subject}\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`,
    { encoding: 'utf8' },
  );
  console.log(`Claves VAPID creadas en ${file}; la clave privada no se muestra.`);
}
