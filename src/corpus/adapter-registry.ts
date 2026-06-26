import type { CorpusAdapter } from "./adapter.js";

export class CorpusAdapterRegistry {
  private readonly adapters = new Map<string, CorpusAdapter>();

  constructor(adapters: readonly CorpusAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: CorpusAdapter): void {
    if (!adapter.id.trim()) {
      throw new Error("Corpus adapter id is required.");
    }

    if (this.adapters.has(adapter.id)) {
      throw new Error(`Duplicate corpus adapter id "${adapter.id}".`);
    }

    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): CorpusAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  getRequired(adapterId: string): CorpusAdapter {
    const adapter = this.get(adapterId);
    if (!adapter) {
      throw new Error(`Corpus adapter "${adapterId}" is not registered.`);
    }
    return adapter;
  }

  list(): readonly CorpusAdapter[] {
    return [...this.adapters.values()];
  }
}
