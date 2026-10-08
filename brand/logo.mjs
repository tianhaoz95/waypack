// Waypack logo: a paper ticket stub on coral, a handwritten "W" on the stub and a map pin on the
// ticket (design review 2026-10-08, candidate "Ticket stub"; matches the scrapbook app, DECISIONS #60).
// Single source for every icon; see brand/build.mjs. All shapes live on a 1024 grid.

export const CORAL = "#D9694F";
export const PAPER = "#FFFDF8";
export const INK = "#3D332B"; // pencil, for the handwritten W
export const PERFORATION = "#C9B9A6";

// "W" from Caveat Bold (SIL OFL 1.1, apps/mobile/assets/fonts), outlined so no font is needed to
// render the icon. Font units: 1000/em, y up.
const W_PATH = "M503 -62Q490 -63 479.5 -56.5Q469 -50 465 -40Q461 -35 452.0 -18.5Q443 -2 441 10Q438 42 437.5 72.0Q437 102 440 156Q443 200 452.0 234.5Q461 269 470.0 293.5Q479 318 484.0 330.5Q489 343 486 343Q482 343 477.5 335.5Q473 328 467.5 316.0Q462 304 455.5 290.0Q449 276 442 263Q428 232 409.5 197.5Q391 163 372.0 131.0Q353 99 339 75Q330 65 318.0 46.5Q306 28 292.0 8.0Q278 -12 263 -25Q241 -46 218.0 -50.5Q195 -55 175 -45Q165 -44 154.0 -34.5Q143 -25 136.5 -11.0Q130 3 133 15Q132 29 133.5 58.5Q135 88 139.0 123.5Q143 159 147.5 192.0Q152 225 156 247Q165 311 180.5 378.0Q196 445 209 513Q217 533 223.5 558.5Q230 584 237 606Q238 628 253.0 633.5Q268 639 285.5 635.0Q303 631 310 621Q320 611 329.0 590.0Q338 569 324 537Q304 488 285.5 417.5Q267 347 252 247Q248 223 243.5 193.5Q239 164 235.5 137.0Q232 110 230.5 92.26666666666667Q229 74.53333333333333 231 73.6888888888889Q239 72 248.5 83.0Q258 94 269 118Q310 186 346.5 253.0Q383 320 420 393Q437 422 454.5 456.5Q472 491 488 520Q505 550 521.0 578.0Q537 606 549.0 625.5Q561 645 567 647Q594 647 607.5 633.0Q621 619 629 599Q631 594 631.5 582.0Q632 570 628 561Q627 554 619.5 532.0Q612 510 606 483Q596 456 588.5 429.5Q581 403 578 386Q570 343 558.0 291.87867647058823Q546 240.75735294117646 537.5 190.62867647058823Q529 140.5 528 100.79411764705883Q527 73 528.5 64.5Q530 56 534 47Q536 39 543.0 43.0Q550 47 557 57Q571 78 578.5 93.0Q586 108 594.0 125.5Q602 143 616 170Q641 216 667.5 271.0Q694 326 718.5 380.0Q743 434 761 476Q780 530 793.0 563.5Q806 597 817.0 615.0Q828 633 838 639Q843 643 859.5 643.0Q876 643 885 635Q889 631 899.0 622.2068965517242Q909 613.4137931034483 908 601Q902.6666666666666 584.6279069767442 889.3333333333333 548.8139534883721Q876 513 858.4516129032259 469.425Q840.9032258064516 425.85 824.4516129032259 386.425Q808 347 797 324Q786 303 776.0 288.0Q766 273 766 265Q766 261 756.0 240.5Q746 220 730.5 191.0Q715 162 697.0 131.0Q679 100 663.0 74.0Q647 48 636 34Q611 3 582.5 -18.5Q554 -40 532.0 -51.0Q510 -62 503 -62Z";

/** A pin with a hole; tip at (cx, cy + r*2.2). */
function pinPath(cx, cy, r) {
  const tip = cy + r * 2.2, hole = r * 0.4;
  return (
    `M${cx} ${tip} C ${cx - r * 0.3} ${cy + r * 1.62} ${cx - r} ${cy + r * 0.98} ${cx - r} ${cy} ` +
    `A ${r} ${r} 0 1 1 ${cx + r} ${cy} C ${cx + r} ${cy + r * 0.98} ${cx + r * 0.3} ${cy + r * 1.62} ${cx} ${tip} Z ` +
    `M${cx - hole} ${cy} A ${hole} ${hole} 0 1 0 ${cx + hole} ${cy} A ${hole} ${hole} 0 1 0 ${cx - hole} ${cy} Z`
  );
}

// Ticket-local coordinates (centred on 0,0, before the -10° tilt).
const TICKET = { x: -390, y: -230, w: 780, h: 460, r: 36, notchX: -110, notchR: 44 };
// The W: 300 units tall-ish, visually centred on the stub (glyph bounds x 132–908 → centre 520).
const W_SHAPE = `<path transform="translate(${-250 - 0.3 * 520} 110) scale(0.3 -0.3)" d="${W_PATH}"/>`;
const PIN = pinPath(130, -40, 92);

const notchMask = (id, cutouts = "") =>
  `<mask id="${id}" maskUnits="userSpaceOnUse" x="-512" y="-512" width="1024" height="1024">` +
  `<rect x="-512" y="-512" width="1024" height="1024" fill="#fff"/>` +
  `<circle cx="${TICKET.notchX}" cy="${TICKET.y}" r="${TICKET.notchR}" fill="#000"/>` +
  `<circle cx="${TICKET.notchX}" cy="${TICKET.y + TICKET.h}" r="${TICKET.notchR}" fill="#000"/>${cutouts}</mask>`;

const ticketRect = (fill, mask, filter = "") =>
  `<rect x="${TICKET.x}" y="${TICKET.y}" width="${TICKET.w}" height="${TICKET.h}" rx="${TICKET.r}" fill="${fill}" mask="url(#${mask})"${filter}/>`;

const shadowFilter = `<filter id="wp-shadow-t" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#3C2814" flood-opacity=".3"/></filter>`;

/**
 * The ticket mark alone (transparent background), optionally scaled about the centre.
 * mono: one colour with the W and pin cut out (Android themed icons).
 */
export function glyph({ scale = 1, mono = false, shadow = true } = {}) {
  let body;
  if (mono) {
    const cut = `<g fill="#000">${W_SHAPE}<path d="${PIN}" fill-rule="evenodd"/></g>`;
    body = `<defs>${notchMask("wp-mono", cut)}</defs>${ticketRect("#fff", "wp-mono")}`;
  } else {
    body =
      `<defs>${notchMask("wp-notch")}${shadow ? shadowFilter : ""}</defs>` +
      ticketRect(PAPER, "wp-notch", shadow ? ` filter="url(#wp-shadow-t)"` : "") +
      `<path d="M${TICKET.notchX} ${TICKET.y + 60} V${TICKET.y + TICKET.h - 60}" stroke="${PERFORATION}" stroke-width="10" stroke-dasharray="22 18"/>` +
      `<g fill="${INK}">${W_SHAPE}</g>` +
      `<path d="${PIN}" fill="${CORAL}" fill-rule="evenodd"/>`;
  }
  const g = `<g transform="translate(512 512) rotate(-10)">${body}</g>`;
  return scale === 1 ? g : `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">${g}</g>`;
}

const svg = (body, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;

/** Full-bleed square (iOS and the web touch icon: the OS rounds the corners). */
export const square = () => svg(`<rect width="1024" height="1024" fill="${CORAL}"/>${glyph()}`);

/** Rounded tile with transparent corners (favicon, site header, legacy Android). */
export const tile = () => svg(`<rect width="1024" height="1024" rx="230" fill="${CORAL}"/>${glyph()}`);

/** macOS: the icon draws its own rounded body inside the 1024 canvas (Apple's 824/100 grid) with a soft shadow. */
export const mac = () =>
  svg(
    `<g filter="url(#wp-shadow)"><rect x="100" y="100" width="824" height="824" rx="185" fill="${CORAL}"/></g>` +
      `<g transform="translate(100 100) scale(${824 / 1024})">${glyph()}</g>`,
    `<filter id="wp-shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity=".28"/></filter>`,
  );

/** Android adaptive layers (108dp canvas; the mark fits the 66dp safe circle). */
export const androidBackground = () => svg(`<rect width="1024" height="1024" fill="${CORAL}"/>`);
export const androidForeground = () => svg(glyph({ scale: 0.65 }));
export const androidMonochrome = () => svg(glyph({ scale: 0.65, mono: true }));
