import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { hashPassword } from '../infrastructure/security/password.js';
import { USERNAME_PATTERN } from '../modules/auth/password-policy.js';

// First administrator of an empty database. Variables:
//   BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_USERNAME (e.g. «pedro.alvarez»; if
//   missing, the e-mail before the @), BOOTSTRAP_ADMIN_EMAIL (optional) and
//   BOOTSTRAP_ADMIN_PASSWORD (12 to 128 characters; its own password, not an
//   ID number, so no change is forced).
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Falta DATABASE_URL');
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null;
  const username = (process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || email?.split('@')[0] || '').toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!name || name.length > 100) throw new Error('Nombre inválido');
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error('Correo inválido');
  if (username.length < 3 || username.length > 50 || !USERNAME_PATTERN.test(username)) {
    throw new Error('Usuario inválido: minúsculas y números, separados por punto, guion o guion bajo (p. ej. pedro.alvarez)');
  }
  if (!password || password.length < 12 || password.length > 128) {
    throw new Error('La contraseña debe tener entre 12 y 128 caracteres');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    if (await prisma.user.count({ where: { role: 'ADMIN' } })) {
      throw new Error('Ya existe un administrador. Crea otras cuentas desde el API autenticado');
    }
    const user = await prisma.user.create({
      data: { name, username, email, passwordHash: await hashPassword(password), passwordChangedAt: new Date(), role: 'ADMIN' },
      select: { id: true, name: true, username: true, email: true, role: true },
    });
    console.log('Administrador creado:', user);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error && !('code' in error)) console.error(error.message);
  else console.error('No se pudo crear el administrador; verifica conexión y que el usuario o el correo no estén repetidos');
  process.exitCode = 1;
});
