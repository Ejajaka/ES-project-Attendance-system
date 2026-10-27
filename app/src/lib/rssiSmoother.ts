/**
 * RSSI smoothing. Raw signal strength jitters by several dB from multipath,
 * body shadowing and orientation, so we report a rolling median instead of a
 * single scan sample. Median is robust to the occasional deep fade.
 */
export class RssiSmoother {
  private values: number[] = [];

  constructor(private readonly size = 5) {}

  /** Add a sample and return the current median. */
  push(value: number): number {
    this.values.push(value);
    while (this.values.length > this.size) this.values.shift();
    return this.median() ?? value;
  }

  median(): number | null {
    if (this.values.length === 0) return null;
    const s = [...this.values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }

  reset(): void {
    this.values = [];
  }
}
