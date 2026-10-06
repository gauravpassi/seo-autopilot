/**
 * Tiny in-memory stand-in for the subset of the supabase-js query builder used by lib/change-ingest.ts
 * and lib/jobs.ts: select/insert/update with eq/neq/in/is/gte/lte/lt/gt/order/limit/single/maybeSingle
 * and { count: "exact", head: true }.
 */
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

class Query implements PromiseLike<{ data: unknown; error: null | { message: string }; count?: number | null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private countMode = false;
  private head = false;
  private returning = false;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.op = "select";
    else this.returning = true;
    if (opts?.count) this.countMode = true;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  gte(c: string, v: string | number) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as string) >= v); return this; }
  lte(c: string, v: string | number) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as string) <= v); return this; }
  gt(c: string, v: string | number) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as string) > v); return this; }
  lt(c: string, v: string | number) { this.filters.push((r) => r[c] !== null && r[c] !== undefined && (r[c] as string) < v); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.orderBy = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  private run() {
    const rows = this.db.tables[this.table] ?? (this.db.tables[this.table] = []);
    if (this.op === "insert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const inserted = list.map((r) => ({ id: r.id ?? `${this.table}-${++this.db.seq}`, ...r }));
      rows.push(...inserted);
      return this.shape(inserted);
    }
    let matched = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of matched) Object.assign(r, this.payload);
      return this.shape(matched);
    }
    if (this.op === "delete") {
      this.db.tables[this.table] = rows.filter((r) => !matched.includes(r));
      return this.shape(matched);
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
    }
    const count = matched.length;
    if (this.lim !== null) matched = matched.slice(0, this.lim);
    if (this.head) return { data: null, error: null, count };
    return { ...this.shape(matched), count: this.countMode ? count : null };
  }

  private shape(list: Row[]) {
    if (this.mode === "single") return list.length === 1 ? { data: list[0], error: null } : { data: null, error: { message: `expected 1 row, got ${list.length}` } };
    if (this.mode === "maybe") return { data: list[0] ?? null, error: null };
    return { data: list, error: null };
  }

  then<A, B>(ok?: ((v: { data: unknown; error: null | { message: string }; count?: number | null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }
}

export class FakeDb {
  seq = 0;
  constructor(public tables: Record<string, Row[]> = {}) {}
  from(t: string) {
    return new Query(this, t);
  }
}
