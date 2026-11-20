@AGENTS.md

# Claude Code

Trabaja desde la raíz del monorepo (la carpeta que contiene `apps/api`,
`apps/web` y `pnpm-workspace.yaml`); no supongas una ruta fija de Windows.

Antes de implementar:
1. Lee `docs/project-context.md` (contexto vigente) y `docs/next-task.md`
   (próxima tarea).
2. Lee el final de `docs/development-status.md` (bitácora).
3. Comprueba que lo que dicen corresponda con el repositorio local. Si no
   coincide, mandan el código y los resultados ejecutados: documenta la
   diferencia.

Responde al usuario siempre en español.

Mantén las decisiones del negocio, la autenticación y los permisos existentes.
Trabaja en la tarea que pida el usuario, o en la de `docs/next-task.md`, sin
ampliar el alcance por tu cuenta. Al terminar, actualiza
`docs/development-status.md`.
