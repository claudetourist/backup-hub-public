/** Colour maths for the colour tests: contrast (WCAG) and colour-blind simulation with a distance (CIE76 delta E). Test helper only. */

export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type Vision = 'normal' | 'protan' | 'deutan';

/** Machado, Oliveira and Fernandes (2009), full severity, applied to linear RGB. */
const MATRICES: Record<Exclude<Vision, 'normal'>, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function toLab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** How far apart two colours look to a person with the given vision (CIE76 delta E: about 2 is just noticeable, 10 or more is clear). */
export function colourDistance(a: string, b: string, vision: Vision): number {
  const lab = (hex: string): [number, number, number] => {
    const rgb = hexToRgb(hex).map(linear) as [number, number, number];
    if (vision === 'normal') return toLab(rgb);
    const m = MATRICES[vision];
    const clamp = (v: number): number => Math.min(1, Math.max(0, v));
    return toLab(m.map((row) => clamp(row[0]! * rgb[0] + row[1]! * rgb[1] + row[2]! * rgb[2])) as [number, number, number]);
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** The smallest distance between any two of the colours (with the pair), under one kind of vision. */
export function closestPair(colours: Record<string, string>, vision: Vision): { distance: number; pair: [string, string] } {
  const names = Object.keys(colours);
  let best = { distance: Infinity, pair: ['', ''] as [string, string] };
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const distance = colourDistance(colours[names[i]!]!, colours[names[j]!]!, vision);
      if (distance < best.distance) best = { distance, pair: [names[i]!, names[j]!] };
    }
  }
  return best;
}
