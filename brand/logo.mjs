// Waypack logo: a map pin dropped on a folded map whose four panels zigzag into a "W".
// Single source for every icon; see brand/build.mjs. All shapes live on a 1024 grid.

export const BLUE_TOP = "#2f86ff";
export const BLUE_BOTTOM = "#1452c2";
export const FOLD = "#b9d3ff"; // shaded map panels

const gradient = `<linearGradient id="wp-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BLUE_TOP}"/><stop offset="1" stop-color="${BLUE_BOTTOM}"/></linearGradient>`;

/** The folded map: 4 panels between 5 fold lines, tops zigzagging high/low. */
function foldedMap({ light = "#fff", shade = FOLD } = {}) {
  const x0 = 200, w = 156, hi = 478, lo = 558, h = 292;
  const xs = [0, 1, 2, 3, 4].map((i) => x0 + i * w), ys = [hi, lo, hi, lo, hi];
  return [0, 1, 2, 3]
    .map((i) => `<polygon points="${xs[i]},${ys[i]} ${xs[i + 1]},${ys[i + 1]} ${xs[i + 1]},${ys[i + 1] + h} ${xs[i]},${ys[i] + h}" fill="${i % 2 ? shade : light}"/>`)
    .join("");
}

/** Map pin with a real hole (even-odd), so it reads on any background. Tip lands on the middle fold. */
function pin(fill = "#fff") {
  const cx = 512, cy = 270, r = 104, hole = r * 0.4, tip = cy + r * 2.2;
  const d =
    `M${cx} ${tip} C ${cx - r * 0.3} ${cy + r * 1.62} ${cx - r} ${cy + r * 0.98} ${cx - r} ${cy} ` +
    `A ${r} ${r} 0 1 1 ${cx + r} ${cy} C ${cx + r} ${cy + r * 0.98} ${cx + r * 0.3} ${cy + r * 1.62} ${cx} ${tip} Z ` +
    `M${cx - hole} ${cy} A ${hole} ${hole} 0 1 0 ${cx + hole} ${cy} A ${hole} ${hole} 0 1 0 ${cx - hole} ${cy} Z`;
  return `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
}

/** The white mark alone (transparent), optionally scaled about the centre. */
export function glyph({ scale = 1, light, shade } = {}) {
  const body = foldedMap({ light, shade }) + pin(light);
  return scale === 1 ? body : `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">${body}</g>`;
}

const svg = (body, defs = gradient) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${defs}</defs>${body}</svg>`;

/** Full-bleed square (iOS and the web touch icon: the OS rounds the corners). */
export const square = () => svg(`<rect width="1024" height="1024" fill="url(#wp-bg)"/>${glyph()}`);

/** Rounded tile with transparent corners (favicon, site header, in-app logo, legacy Android). */
export const tile = () => svg(`<rect width="1024" height="1024" rx="230" fill="url(#wp-bg)"/>${glyph()}`);

/** macOS: the icon draws its own rounded body inside the 1024 canvas (Apple's 824/100 grid) with a soft shadow. */
export const mac = () =>
  svg(
    `<g filter="url(#wp-shadow)"><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#wp-bg)"/></g>` +
      `<g transform="translate(100 100) scale(${824 / 1024})">${glyph()}</g>`,
    gradient + `<filter id="wp-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".28"/></filter>`,
  );

/** Android adaptive layers (108dp canvas; the mark fits the 66dp safe circle). */
export const androidBackground = () => svg(`<rect width="1024" height="1024" fill="url(#wp-bg)"/>`);
export const androidForeground = () => svg(glyph({ scale: 0.65 }));
export const androidMonochrome = () => svg(glyph({ scale: 0.65, light: "#fff", shade: "rgba(255,255,255,.55)" }));
