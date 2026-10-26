# Generates the PWA icons in public/icons from the mark of public/favicon.svg
# (brand gradient #00A5D7 -> #1184E6, white "We" mark).
# Requires PyMuPDF (pip install pymupdf). Run from apps/web:
#   python scripts/make-pwa-icons.py "" public/favicon.svg public/icons
# The first argument is an optional extra module path ("" if pymupdf is installed).
# MuPDF renders the antialiased shapes; the gradient is computed here because
# MuPDF does not paint SVG gradients.
import re, sys, os, warnings
warnings.filterwarnings('ignore')
if sys.argv[1]: sys.path.insert(0, sys.argv[1])
import fitz
src = open(sys.argv[2], encoding='utf-8').read()
out = sys.argv[3]
g = re.search(r'<g fill="#ffffff" transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)">(.*?)</g>', src, re.S)
tx, ty, sc, paths = float(g.group(1)), float(g.group(2)), float(g.group(3)), g.group(4)
def mark(factor):
    return f'<g transform="translate(32 32) scale({factor}) translate(-32 -32)"><g fill="#000" transform="translate({tx} {ty}) scale({sc})">{paths}</g></g>'
def alpha(svg_body, size):
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{svg_body}</svg>'
    page = fitz.open(stream=svg.encode(), filetype='svg')[0]
    z = size / page.rect.width
    pix = page.get_pixmap(matrix=fitz.Matrix(z, z), alpha=True)
    s = pix.samples; n = pix.n
    return [s[i * n + n - 1] for i in range(pix.width * pix.height)]
# Brand gradient of the favicon: #00A5D7 (bottom-left) -> #1184E6 (top-right).
A = (0x00, 0xA5, 0xD7); B = (0x11, 0x84, 0xE6)
def build(name, size, shape, mark_factor, background=True):
    shape_a = alpha(shape, size) if background else None
    mark_a = alpha(mark(mark_factor), size)
    buf = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            i = y * size + x
            t = ((x + 0.5) / size + 1 - (y + 0.5) / size) / 2
            ma = mark_a[i] / 255
            if background:
                sa = shape_a[i]
                rgb = [round((A[k] + (B[k] - A[k]) * t) * (1 - ma) + 255 * ma) for k in range(3)]
                a = sa
            else:
                rgb = [255, 255, 255]; a = mark_a[i]
            buf[i*4:i*4+4] = bytes((*rgb, a))
    pix = fitz.Pixmap(fitz.csRGB, size, size, bytes(buf), True)
    pix.save(os.path.join(out, name))
    print(name, size)
rounded = '<rect width="64" height="64" rx="14" fill="#000"/>'
square = '<rect width="64" height="64" fill="#000"/>'
build('icon-192.png', 192, rounded, 1)
build('icon-512.png', 512, rounded, 1)
build('icon-maskable-192.png', 192, square, 0.72)
build('icon-maskable-512.png', 512, square, 0.72)
build('apple-touch-icon.png', 180, square, 0.72)
build('badge-96.png', 96, None, 1.25, background=False)
