/** Small in-process LRU with TTL. Per-instance only; never shared across tenants by key design. */
export class LruCache<K, V> {
  private map = new Map<K, { v: V; at: number }>();

  constructor(private readonly max: number, private readonly ttlMs: number) {}

  get(k: K): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, { v, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}
