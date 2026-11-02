# Build the app icon set from the designer's logo (icons/logo-source.svg, kept unchanged).
# Usage: python3 scripts/make-icons.py <folder with source.svg> <output folder>
# then render the PNGs (icon-192/512, icon-maskable-512, apple-touch-icon 180, favicon-32) from the SVGs with a browser.
import re, sys
S = sys.argv[1]; OUT = sys.argv[2]
src = open(f'{S}/source.svg', encoding='utf-8').read()
defs = re.search(r'<defs>.*?</defs>', src, re.S).group(0)
defs = re.sub(r'<!--.*?-->', '', defs)
play = re.search(r'  <!-- Outer Neon Play Button -->\s*(<g filter="url\(#dropShadow\)">.*?\n  </g>)', src, re.S).group(1)
clap = re.search(r'  <!-- Clapperboard Icon -->\s*(<g fill="#05072e">.*?\n  </g>)', src, re.S).group(1)
bar = re.search(r'(<rect x="142" y="676"[^>]*/>)', src).group(1)
strip = lambda s: re.sub(r'\s*<!--.*?-->', '', s)
play, clap = strip(play), strip(clap)
CY = 417  # vertical centre of the artwork once the wordmark is removed

def svg(body, title='ClipCut'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">\n  <title>{title}</title>\n  {defs}\n{body}\n</svg>\n'

def art(scale, parts):
    return f'  <g transform="translate(500 500) scale({scale}) translate(-500 -{CY})">\n    ' + '\n    '.join(parts) + '\n  </g>'

squircle = '<rect x="38" y="38" width="924" height="924" rx="220" fill="url(#bgGrad)"/>'
full = '<rect width="1000" height="1000" fill="url(#bgGrad)"/>'

# app icon (transparent corners), as the designer drew it minus the wordmark
open(f'{OUT}/icon.svg', 'w').write(svg('  ' + squircle + '\n' + art(1.08, [play, clap, bar])))
# maskable: full bleed, artwork inside the 80% safe circle
open(f'{OUT}/icon-maskable.svg', 'w').write(svg('  ' + full + '\n' + art(0.82, [play, clap, bar])))
# Apple touch icon: full bleed (iOS rounds the corners itself)
open(f'{OUT}/icon-apple.svg', 'w').write(svg('  ' + full + '\n' + art(1.0, [play, clap, bar])))
# favicon: bigger artwork, no shadow, clapperboard reduced to a plain shape so it survives 16–32 px
play_flat = play.replace('<g filter="url(#dropShadow)">', '<g>')
bar_flat = bar.replace(' filter="url(#dropShadow)"', '').replace('y="676" width="716" height="52" rx="26"', 'y="668" width="716" height="68" rx="34"')
clap_simple = '<g fill="#05072e"><rect x="344" y="300" width="256" height="64" rx="24" transform="rotate(-14 344 300)"/><rect x="348" y="344" width="248" height="170" rx="30"/></g>'
fav_defs_play = play_flat
open(f'{OUT}/favicon.svg', 'w').write(svg('  <rect width="1000" height="1000" rx="230" fill="url(#bgGrad)"/>\n' + art(1.22, [fav_defs_play, clap_simple, bar_flat])))
print('ok')
