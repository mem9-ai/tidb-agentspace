import type { TableDetail } from '../../api/client';

// Short-lived, route-local values only: never persist metadata or share it across workspaces.
export class TableMetadataCache {
  private context = '';
  private entries = new Map<string, { data: TableDetail; expires: number }>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(context: string, name: string): TableDetail | undefined {
    this.reset(context);
    const entry = this.entries.get(name);
    if (!entry) return;
    if (entry.expires <= this.now()) {
      this.entries.delete(name);
      return;
    }
    this.entries.delete(name);
    this.entries.set(name, entry);
    return entry.data;
  }

  set(context: string, name: string, data: TableDetail): void {
    this.reset(context);
    this.entries.delete(name);
    this.entries.set(name, { data, expires: this.now() + 30_000 });
    const oldest = this.entries.keys().next().value;
    if (this.entries.size > 16 && oldest !== undefined) this.entries.delete(oldest);
  }

  private reset(context: string): void {
    if (context === this.context) return;
    this.context = context;
    this.entries.clear();
  }
}
