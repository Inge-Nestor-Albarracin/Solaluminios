# Abrir y retomar Solaluminios con Claude Code

## En un equipo nuevo

1. Instala Git, Node 24, pnpm 11.4.0, PostgreSQL 18, VS Code y la app de
   Claude. El detalle está en `docs/project-context.md`, sección 10.
2. Clona el repositorio en una ruta corta, por ejemplo `C:\dev\Aduvidrios`.
3. Copia los `.env` de `apps/api` desde el respaldo (no están en Git).
4. Desde la raíz, ejecuta `pnpm install --frozen-lockfile`.
5. Prepara la base local: restaura el respaldo o aplica las migraciones.

`AGENTS.md`, `CLAUDE.md` y `docs/` ya vienen en el repositorio, en la raíz del
monorepo. Claude Code los carga al abrir la carpeta.

## Inicio

Abre la carpeta del proyecto en la app de Claude (pestaña Code), en VS Code o
en la terminal:

```powershell
cd C:\dev\Aduvidrios
claude
```

Inicia sesión con tu cuenta de Claude si lo pide. En una sesión nueva, puedes
pedirle que confirme qué instrucciones y documentos leyó.

## Primer encargo en el equipo nuevo

Copia este mensaje en Claude Code:

```text
Retoma el proyecto Solaluminios.
Lee CLAUDE.md, AGENTS.md, docs/project-context.md, docs/next-task.md
y el final de docs/development-status.md.

Revisa git status, que existan los .env de apps/api (sin mostrar su
contenido), que la base local responda y que las migraciones estén al
día. Ejecuta build, lint y pruebas de apps/api y apps/web, e informa
los resultados y cualquier diferencia con lo documentado.

No cambies código todavía: después te digo la tarea.
```

## Trabajo diario

- Una tarea concreta por turno y una sola IA editora en la carpeta.
- Al terminar cada tarea, actualizar `docs/development-status.md`.
- **Git:** revisar `git status` y `git diff` y guardar puntos de avance
  después de verificar. No incluir `.env`, secretos, `node_modules` ni `dist`.
  Los documentos se versionan porque no contienen credenciales.
- **Publicación:** push, despliegue o acciones en el servidor solo cuando el
  usuario lo pida.

## Documentación oficial

- Inicio: https://code.claude.com/docs/en/quickstart
- Instrucciones y memoria: https://code.claude.com/docs/en/memory
