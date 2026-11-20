"""Builds the Git Lanes icons from one shape: the Lucide "git-branch" icon (ISC licence, lucide.dev).

Writes:
  media/logo.svg          the glyph in currentColor (view icon; VS Code tints it for the theme)
  media/logo-dark.svg     white glyph for dark themes (editor tab)
  media/logo-light.svg    dark grey glyph for light themes (editor tab)
  media/icon.svg          marketplace icon source: the glyph in teal and amber, no tile
  media/logo.woff         the glyph as an icon font, for $(git-lanes-logo) in the status bar

Run: pip install skia-pathops fonttools && python3 scripts/build-icons.py
Then render media/icon.png (256 x 256, transparent background) from media/icon.svg, for example with headless Chromium:
  msedge --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size=256,256 --screenshot=media/icon.png media/icon.svg
"""
from pathlib import Path

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen

MEDIA = Path(__file__).resolve().parent.parent / 'media'
LIGHT = '#424242'  # VS Code's icon foreground on light themes
TRUNK = ('#319D94', '#147770')  # marketplace icon: the trunk and its commit, teal (top, bottom)
BRANCH = ('#CA7C09', '#A05817')  # the branch and its commit, amber (tip, base)
ICON_STROKE = 2.6  # bolder than Lucide's 2, so the coloured glyph holds up without a tile
STROKE = 2  # Lucide's stroke width on its 24 x 24 grid
K = 0.5523  # cubic handle length for a quarter circle

# Lucide git-branch: a trunk, two commits and the branch arc between them.
GLYPH = (
    '<line x1="6" x2="6" y1="3" y2="15"/>'
    '<circle cx="18" cy="6" r="3"/>'
    '<circle cx="6" cy="18" r="3"/>'
    '<path d="M18 9a9 9 0 0 1-9 9"/>'
)


def svg(color: str, size: int = 16, tile: str = '') -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" '
        f'stroke="{color}" stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round">{tile}{GLYPH}</svg>\n'
    )


def write_svgs() -> None:
    (MEDIA / 'logo.svg').write_text(svg('currentColor'))
    (MEDIA / 'logo-dark.svg').write_text(svg('#ffffff'))
    (MEDIA / 'logo-light.svg').write_text(svg(LIGHT))
    # Marketplace icon: no tile, the glyph itself in colour, like a browser logo. A PNG cannot follow the theme, so
    # it uses mid-tone colours, every stop at least 3:1 on white and on VS Code's #181818: teal for the default
    # branch's trunk and commit, amber for the branch, each a gentle gradient lit from the top.
    def grad(gid: str, ramp: tuple[str, str], x1: float, y1: float, x2: float, y2: float) -> str:
        return (
            f'<linearGradient id="{gid}" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
            f'<stop offset="0" stop-color="{ramp[0]}"/><stop offset="1" stop-color="{ramp[1]}"/></linearGradient>'
        )

    w = ICON_STROKE
    icon = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="1 1 22 22" fill="none" '
        'stroke-linecap="round" stroke-linejoin="round">'
        f'<defs>{grad("trunk", TRUNK, 0, 2, 0, 22)}{grad("branch", BRANCH, 20, 3, 9, 19)}</defs>'
        f'<path d="M18 9a9 9 0 0 1-9 9" stroke="url(#branch)" stroke-width="{w}"/>'
        f'<circle cx="18" cy="6" r="3" stroke="url(#branch)" stroke-width="{w}"/>'
        f'<line x1="6" x2="6" y1="3" y2="15" stroke="url(#trunk)" stroke-width="{w}"/>'
        f'<circle cx="6" cy="18" r="3" stroke="url(#trunk)" stroke-width="{w}"/>'
        '</svg>\n'
    )
    (MEDIA / 'icon.svg').write_text(icon)


# ---- icon font ----
UPM = 300  # same metrics as the codicon font, so the glyph lines up with built-in status bar icons
S = UPM / 24


def pt(x: float, y: float) -> tuple[float, float]:
    return x * S, UPM - y * S


def circle(p: pathops.Path, cx: float, cy: float, r: float) -> None:
    k = r * K
    p.moveTo(*pt(cx + r, cy))
    p.cubicTo(*pt(cx + r, cy + k), *pt(cx + k, cy + r), *pt(cx, cy + r))
    p.cubicTo(*pt(cx - k, cy + r), *pt(cx - r, cy + k), *pt(cx - r, cy))
    p.cubicTo(*pt(cx - r, cy - k), *pt(cx - k, cy - r), *pt(cx, cy - r))
    p.cubicTo(*pt(cx + k, cy - r), *pt(cx + r, cy - k), *pt(cx + r, cy))
    p.close()


def glyph_outline() -> pathops.Path:
    parts = []
    line = pathops.Path()
    line.moveTo(*pt(6, 3))
    line.lineTo(*pt(6, 15))
    parts.append(line)
    for cx, cy in ((18, 6), (6, 18)):
        c = pathops.Path()
        circle(c, cx, cy, 3)
        parts.append(c)
    arc = pathops.Path()  # quarter circle around (9, 9) from (18, 9) to (9, 18)
    arc.moveTo(*pt(18, 9))
    arc.cubicTo(*pt(18, 9 + 9 * K), *pt(9 + 9 * K, 18), *pt(9, 18))
    parts.append(arc)
    for p in parts:
        p.stroke(STROKE * S, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
        p.convertConicsToQuads()
    out = pathops.Path()
    pathops.union(parts, out.getPen())
    return out


def write_font() -> None:
    pen = T2CharStringPen(UPM, None)
    glyph_outline().draw(pen)
    fb = FontBuilder(UPM, isTTF=False)
    fb.setupGlyphOrder(['.notdef', 'logo'])
    fb.setupCharacterMap({0xE000: 'logo'})
    fb.setupCFF('GitLanesIcons', {'FullName': 'Git Lanes Icons'}, {'.notdef': T2CharStringPen(UPM, None).getCharString(), 'logo': pen.getCharString()}, {})
    fb.setupHorizontalMetrics({'.notdef': (UPM, 0), 'logo': (UPM, 0)})
    fb.setupHorizontalHeader(ascent=UPM, descent=0)
    fb.setupNameTable({'familyName': 'Git Lanes Icons', 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, usWinAscent=UPM, usWinDescent=0)
    fb.setupPost()
    fb.font.flavor = 'woff'
    fb.save(str(MEDIA / 'logo.woff'))


if __name__ == '__main__':
    write_svgs()
    write_font()
