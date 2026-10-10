use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub content: String,
    pub language: String,
    pub collection_id: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    pub favorite: bool,
    pub copy_count: u32,
    pub created_at: String,
    pub updated_at: String,
    pub last_copied_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub id: Option<String>,
    pub title: Option<String>,
    pub content: String,
    pub language: Option<String>,
    pub collection_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub favorite: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextImportJob {
    pub id: String,
    pub status: String,
    pub collection_id: String,
    pub discovered_count: usize,
    pub processed_count: usize,
    pub imported_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EmbeddingProviderType {
    Local,
    Openai,
}

impl Default for EmbeddingProviderType {
    fn default() -> Self {
        EmbeddingProviderType::Local
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub provider: EmbeddingProviderType,
    #[serde(default = "default_openai_url")]
    pub openai_base_url: String,
    #[serde(default)]
    pub openai_api_key: String,
    #[serde(default = "default_openai_model")]
    pub openai_model: String,
    #[serde(default = "default_openai_dimensions")]
    pub openai_dimensions: usize,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_editor_mode")]
    pub editor_mode: String,
    #[serde(default = "default_open_snippets_in_new_tabs")]
    pub open_snippets_in_new_tabs: bool,
}

fn default_openai_url() -> String {
    "https://api.openai.com/v1".to_string()
}

fn default_openai_model() -> String {
    "text-embedding-3-small".to_string()
}

fn default_openai_dimensions() -> usize {
    512
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_editor_mode() -> String {
    "split".to_string()
}

fn default_open_snippets_in_new_tabs() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            provider: EmbeddingProviderType::Local,
            openai_base_url: default_openai_url(),
            openai_api_key: String::new(),
            openai_model: default_openai_model(),
            openai_dimensions: default_openai_dimensions(),
            theme: default_theme(),
            editor_mode: default_editor_mode(),
            open_snippets_in_new_tabs: default_open_snippets_in_new_tabs(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilter {
    pub query: Option<String>,
    #[serde(default = "default_search_mode")]
    pub search_mode: String, // "hybrid" | "semantic" | "keyword"
    pub collection_ids: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub languages: Option<Vec<String>>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub favorite_only: Option<bool>,
    #[serde(default = "default_sort_by")]
    pub sort_by: String, // "created_desc", "created_asc", "updated_desc", "title_asc", "copies_desc"
    pub limit: Option<usize>,
}

fn default_search_mode() -> String {
    "hybrid".to_string()
}

fn default_sort_by() -> String {
    "relevance".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub snippet: Snippet,
    pub score: f32,
    pub vector_score: Option<f32>,
    pub keyword_score: Option<f32>,
    pub highlight: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub local_model_loaded: bool,
    pub local_model_name: String,
    pub local_dimension: usize,
    pub active_provider: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestProviderResult {
    pub success: bool,
    pub dimension: usize,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub filename: String,
    pub size_bytes: u64,
    pub path: String,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub snippets: Vec<Snippet>,
    pub collections: Vec<Collection>,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    pub settings: AppSettings,
    pub provider_status: ProviderStatus,
    pub database_info: DatabaseInfo,
}
