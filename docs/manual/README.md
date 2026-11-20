# Manuales de usuario

| Manual | Fuente | PDF |
| --- | --- | --- |
| Ventas | `manual-ventas.html` | `Manual-Ventas.pdf` |
| Bodega | `manual-bodega.html` | `Manual-Bodega.pdf` |
| Administración | pendiente | |

- `assets/manual.css`: estilos de impresión compartidos.
- `assets/fonts`: Nunito Sans, licencia OFL.
- `assets/logo-*.svg`: el logo, generado de `apps/web/src/components/brand/logoPaths.ts`.
- `img/`: los pantallazos.

## Cómo se hicieron los pantallazos

Se tomaron el 18/11/2026 con Edge sin ventana (protocolo DevTools), a 1280×800
con escala 1,5, y en celular a 390×844 con escala 2.

La app corría contra una base local de demostración con:
- el catálogo real;
- la sucursal 7 de agosto;
- una «Bodega 116» de ejemplo;
- clientes, proveedores y personas ficticios.

No se usaron datos reales.

**Pendiente:** las capturas que solo se pueden hacer en un celular real están
marcadas en el manual como «Pantallazo pendiente»:
- instalar la app;
- las notificaciones;
- el lector Bluetooth.

## Regenerar el PDF

Después de editar el HTML, desde PowerShell:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --no-pdf-header-footer --user-data-dir="$env:TEMP\edge-manual" --virtual-time-budget=8000 --print-to-pdf="$PWD\docs\manual\Manual-Ventas.pdf" "file:///$($PWD.Path -replace '\\','/')/docs/manual/manual-ventas.html"
```

Ejecútalo desde la raíz del repositorio. El tamaño de página (A4), los
márgenes y el pie de página están en el `<style>` de cada HTML.
