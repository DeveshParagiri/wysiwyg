/**
 * Minimal DOM geometry globals for pdfjs in Node.
 *
 * pdfjs expects DOMMatrix (and checks for ImageData / Path2D) and, under Node,
 * tries to borrow them from the optional native `@napi-rs/canvas`. When that
 * isn't installed — a bundled build, or a platform without prebuilt binaries —
 * parsing fails with "DOMMatrix is not defined". wysiwyg only reads operator
 * lists and never renders, so a small 2D affine DOMMatrix is enough; ImageData
 * and Path2D are inert placeholders. Installed only when missing.
 */

type Init = number[] | Float32Array | Float64Array | string | undefined;

class DOMMatrixPolyfill {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(init?: Init) {
    if (Array.isArray(init) || ArrayBuffer.isView(init)) {
      const m = Array.from(init as ArrayLike<number>);
      if (m.length >= 6)
        [this.a, this.b, this.c, this.d, this.e, this.f] =
          m.length === 16 ? [m[0], m[1], m[4], m[5], m[12], m[13]] : m;
    }
  }

  get is2D(): boolean {
    return true;
  }

  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  multiplySelf(o: DOMMatrixPolyfill): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * o.a + c * o.b;
    this.b = b * o.a + d * o.b;
    this.c = a * o.c + c * o.d;
    this.d = b * o.c + d * o.d;
    this.e = a * o.e + c * o.f + e;
    this.f = b * o.e + d * o.f + f;
    return this;
  }

  preMultiplySelf(o: DOMMatrixPolyfill): this {
    const copy = new DOMMatrixPolyfill([o.a, o.b, o.c, o.d, o.e, o.f]).multiplySelf(this);
    Object.assign(this, { a: copy.a, b: copy.b, c: copy.c, d: copy.d, e: copy.e, f: copy.f });
    return this;
  }

  multiply(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    return new DOMMatrixPolyfill([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(o);
  }

  translateSelf(x = 0, y = 0): this {
    return this.multiplySelf(new DOMMatrixPolyfill([1, 0, 0, 1, x, y]));
  }

  translate(x = 0, y = 0): DOMMatrixPolyfill {
    return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, x, y]));
  }

  scaleSelf(sx = 1, sy = sx): this {
    return this.multiplySelf(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
  }

  scale(sx = 1, sy = sx): DOMMatrixPolyfill {
    return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
  }

  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (!det) {
      Object.assign(this, {
        a: Number.NaN,
        b: Number.NaN,
        c: Number.NaN,
        d: Number.NaN,
        e: Number.NaN,
        f: Number.NaN,
      });
      return this;
    }
    const { a, b, c, d, e, f } = this;
    this.a = d / det;
    this.b = -b / det;
    this.c = -c / det;
    this.d = a / det;
    this.e = (c * f - d * e) / det;
    this.f = (b * e - a * f) / det;
    return this;
  }

  inverse(): DOMMatrixPolyfill {
    return new DOMMatrixPolyfill([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf();
  }

  transformPoint(p: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

class Placeholder {}

export function installDomPolyfills(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = DOMMatrixPolyfill;
  if (typeof g.ImageData === "undefined") g.ImageData = Placeholder;
  if (typeof g.Path2D === "undefined") g.Path2D = Placeholder;
}
