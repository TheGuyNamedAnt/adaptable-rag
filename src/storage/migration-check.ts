export type StorageMigrationCheckStatus = "passed" | "failed";

export interface StorageMigrationCheckItem {
  readonly id: string;
  readonly status: StorageMigrationCheckStatus;
  readonly message: string;
  readonly expectedVersion?: number;
  readonly actualVersion?: number;
}

export interface StorageMigrationCheck {
  readonly status: StorageMigrationCheckStatus;
  readonly storageKind: string;
  readonly schemaVersion: number;
  readonly checks: readonly StorageMigrationCheckItem[];
}

export interface StorageMigrationCheckProvider {
  migrationCheck(): StorageMigrationCheck | Promise<StorageMigrationCheck>;
}
