export interface Snippet {
  id: string;
  title: string;
  content: string;
  language: string;
  collectionId: string;
  tags: string[];
  keywords: string[];
  favorite: boolean;
  copyCount: number;
  createdAt: string;
  updatedAt: string;
  lastCopiedAt?: string | null;
}

export interface SnippetInput {
  id?: string;
  title?: string;
  content: string;
  language?: string;
  collectionId?: string;
  tags?: string[];
  favorite?: boolean;
}

export interface TextImportJob {
  id: string;
  status: "queued" | "scanning" | "importing" | "completed" | "failed";
  collectionId: string;
  discoveredCount: number;
  processedCount: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Collection {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  createdAt: string;
}

export type EmbeddingProviderType = "local" | "openai";

export interface AppSettings {
  provider: EmbeddingProviderType;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiDimensions: number;
  theme: "dark" | "light" | "system";
  editorMode: "split" | "edit" | "preview";
  openSnippetsInNewTabs: boolean;
}

export interface SearchFilter {
  query?: string;
  searchMode: "hybrid" | "semantic" | "keyword";
  collectionIds?: string[];
  tags?: string[];
  languages?: string[];
  dateFrom?: string;
  dateTo?: string;
  favoriteOnly?: boolean;
  sortBy: string;
  limit?: number;
}

export interface SearchResult {
  snippet: Snippet;
  score: number;
  vectorScore?: number | null;
  keywordScore?: number | null;
  highlight?: string | null;
}

export interface ProviderStatus {
  localModelLoaded: boolean;
  localModelName: string;
  localDimension: number;
  activeProvider: string;
  message?: string | null;
}

export interface TestProviderResult {
  success: boolean;
  dimension: number;
  latencyMs: number;
  error?: string | null;
}

export interface DatabaseInfo {
  filename: string;
  sizeBytes: number;
  path: string;
  directory: string;
}

export interface AppSnapshot {
  snippets: Snippet[];
  collections: Collection[];
  tags: string[];
  keywords: string[];
  settings: AppSettings;
  providerStatus: ProviderStatus;
  databaseInfo: DatabaseInfo;
}

export interface BackupResult {
  source_dir: string;
  target_dir: string;
  folder_name: string;
  copied_files_count: number;
  copied_files: string[];
  snippets_count: number;
  collections_count: number;
}

export interface BackupPreview {
  backup_dir: string;
  folder_name: string;
  database_file: string;
  snippets_count: number;
  collections_count: number;
  file_count: number;
  total_bytes: number;
  created_at?: string | null;
}

export interface RestoreResult {
  backup_dir: string;
  restored_files_count: number;
  restored_files: string[];
  warnings: string[];
}
