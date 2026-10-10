use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use ort::inputs;
use ort::session::Session;
use ort::value::Tensor;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

use crate::models::{AppSettings, EmbeddingProviderType, TestProviderResult};

pub const MAX_SEQUENCE_LENGTH: usize = 8192;

pub struct LocalOnnxEmbedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    model_name: String,
}

impl LocalOnnxEmbedder {
    pub fn load_from_dir(model_dir: &Path) -> Result<Self, String> {
        let model_path = model_dir.join("model.onnx");
        let tokenizer_path = model_dir.join("tokenizer.json");

        if !model_path.exists() {
            return Err(format!(
                "ONNX model file not found at: {}",
                model_path.display()
            ));
        }
        if !tokenizer_path.exists() {
            return Err(format!(
                "Tokenizer file not found at: {}",
                tokenizer_path.display()
            ));
        }

        let session = Session::builder()
            .map_err(|e| format!("Failed to create ONNX session builder: {e}"))?
            .commit_from_file(&model_path)
            .map_err(|e| {
                format!(
                    "Failed to load ONNX model from {}: {e}",
                    model_path.display()
                )
            })?;

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(|e| {
            format!(
                "Failed to load tokenizer from {}: {e}",
                tokenizer_path.display()
            )
        })?;

        let padding = PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            ..Default::default()
        };
        tokenizer.with_padding(Some(padding));

        let truncation = TruncationParams {
            max_length: MAX_SEQUENCE_LENGTH,
            ..Default::default()
        };
        tokenizer
            .with_truncation(Some(truncation))
            .map_err(|e| format!("Invalid tokenizer truncation: {e}"))?;

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            model_name: "jina-embeddings-v2-small-en".to_string(),
        })
    }

    pub fn model_name(&self) -> &str {
        &self.model_name
    }

    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| format!("Failed to tokenize batch: {e}"))?;

        let batch_size = encodings.len();
        let seq_len = encodings[0].len();

        let mut ids = Vec::with_capacity(batch_size * seq_len);
        let mut mask = Vec::with_capacity(batch_size * seq_len);
        let mut type_ids = Vec::with_capacity(batch_size * seq_len);

        for enc in &encodings {
            ids.extend(enc.get_ids().iter().map(|&x| x as i64));
            mask.extend(enc.get_attention_mask().iter().map(|&x| x as i64));
            type_ids.extend(enc.get_type_ids().iter().map(|&x| x as i64));
        }

        let input_ids = Tensor::from_array(([batch_size, seq_len], ids))
            .map_err(|e| format!("Failed to create input_ids tensor: {e}"))?;
        let attention_mask = Tensor::from_array(([batch_size, seq_len], mask.clone()))
            .map_err(|e| format!("Failed to create attention_mask tensor: {e}"))?;
        let token_type_ids = Tensor::from_array(([batch_size, seq_len], type_ids))
            .map_err(|e| format!("Failed to create token_type_ids tensor: {e}"))?;

        let inputs = inputs![
            "input_ids" => input_ids,
            "attention_mask" => attention_mask,
            "token_type_ids" => token_type_ids,
        ];

        let mut session_guard = self
            .session
            .lock()
            .map_err(|e| format!("Failed to lock ONNX session: {e}"))?;

        let outputs = session_guard
            .run(inputs)
            .map_err(|e| format!("ONNX inference failed: {e}"))?;

        let mut result_embeddings = Vec::with_capacity(batch_size);

        if let Some(sentence_out) = outputs.get("sentence_embedding") {
            let (shape, data) = sentence_out
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("Failed to extract sentence_embedding: {e}"))?;

            if shape.len() != 2 || shape[0] as usize != batch_size || shape[1] <= 0 {
                return Err("Sentence embedding tensor shape mismatch".into());
            }
            let dim = shape[1] as usize;
            for i in 0..batch_size {
                let start = i * dim;
                let end = start + dim;
                if end <= data.len() {
                    let mut vec = data[start..end].to_vec();
                    normalize_l2(&mut vec);
                    result_embeddings.push(vec);
                } else {
                    return Err("Sentence embedding tensor shape mismatch".to_string());
                }
            }
        } else if let Some(token_out) = outputs
            .get("token_embeddings")
            .or_else(|| outputs.get("last_hidden_state"))
        {
            // Mean pooling fallback
            let (shape, data) = token_out
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("Failed to extract token embeddings: {e}"))?;

            if shape.len() != 3 || shape[0] as usize != batch_size || shape[1] as usize != seq_len {
                return Err("Token embedding tensor shape mismatch".into());
            }
            let dim = shape[2] as usize;
            if dim == 0 || data.len() != batch_size * seq_len * dim {
                return Err("Invalid token embedding dimensions".into());
            }
            for i in 0..batch_size {
                let mut pooled = vec![0.0f32; dim];
                let mut mask_sum = 0.0f32;
                for t in 0..seq_len {
                    let m = mask[i * seq_len + t] as f32;
                    if m > 0.0 {
                        mask_sum += m;
                        let offset = (i * seq_len + t) * dim;
                        for d in 0..dim {
                            pooled[d] += data[offset + d] * m;
                        }
                    }
                }
                if mask_sum > 0.0 {
                    for d in 0..dim {
                        pooled[d] /= mask_sum;
                    }
                }
                normalize_l2(&mut pooled);
                result_embeddings.push(pooled);
            }
        } else {
            return Err(
                "Neither 'sentence_embedding' nor token embeddings found in model output"
                    .to_string(),
            );
        }

        for vector in &result_embeddings {
            validate_embedding(vector)?;
        }
        Ok(result_embeddings)
    }

    #[allow(dead_code)]
    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let results = self.embed_batch(&[text])?;
        results
            .into_iter()
            .next()
            .ok_or_else(|| "Empty result from local embedder".to_string())
    }
}

pub fn validate_embedding(vector: &[f32]) -> Result<(), String> {
    if vector.is_empty()
        || vector.iter().any(|x| !x.is_finite())
        || !vector.iter().any(|x| x.abs() > 1e-12)
    {
        return Err("Embedding must be a nonempty, finite, nonzero vector".into());
    }
    Ok(())
}

pub fn normalize_l2(vector: &mut [f32]) {
    let norm = vector
        .iter()
        .map(|x| (*x as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm > 1e-12 {
        for x in vector {
            *x = (*x as f64 / norm) as f32;
        }
    }
}

#[derive(Debug, Serialize)]
struct OpenAiEmbeddingRequest {
    model: String,
    input: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingResponse {
    data: Vec<OpenAiEmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct OpenAiEmbeddingData {
    embedding: Vec<f32>,
    index: usize,
}

pub struct OpenAiEmbedder {
    client: Client,
}

impl OpenAiEmbedder {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    pub async fn embed_batch(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        dimensions: Option<usize>,
        texts: &[String],
    ) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let clean_base = base_url.trim_end_matches('/');
        let url = if clean_base.ends_with("/embeddings") {
            clean_base.to_string()
        } else {
            format!("{}/embeddings", clean_base)
        };

        let request_payload = OpenAiEmbeddingRequest {
            model: model.to_string(),
            input: texts.to_vec(),
            dimensions,
        };

        let mut req = self.client.post(&url).json(&request_payload);
        if !api_key.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", api_key.trim()));
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("Request to embeddings endpoint ({url}) failed: {e}"))?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            return Err(format!("Embeddings API error {status}: {text}"));
        }

        let mut res_data: OpenAiEmbeddingResponse = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse OpenAI embedding response: {e}"))?;

        res_data.data.sort_by_key(|d| d.index);
        if res_data.data.len() != texts.len()
            || res_data.data.iter().enumerate().any(|(i, d)| d.index != i)
        {
            return Err("Embedding response has missing, duplicate, or invalid indices".into());
        }
        let expected = dimensions.unwrap_or_else(|| res_data.data[0].embedding.len());
        for item in &res_data.data {
            validate_embedding(&item.embedding)?;
            if item.embedding.len() != expected {
                return Err("Embedding response has inconsistent or unexpected dimensions".into());
            }
        }

        let mut embeddings = Vec::with_capacity(res_data.data.len());
        for item in res_data.data {
            let mut vec = item.embedding;
            normalize_l2(&mut vec);
            embeddings.push(vec);
        }

        Ok(embeddings)
    }

    pub async fn test_connection(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        dimensions: Option<usize>,
    ) -> TestProviderResult {
        let start = Instant::now();
        let test_text = vec!["SnippetBox embedding connectivity test".to_string()];
        match self
            .embed_batch(base_url, api_key, model, dimensions, &test_text)
            .await
        {
            Ok(embeddings) => {
                let latency_ms = start.elapsed().as_millis() as u64;
                let dim = embeddings.first().map(|v| v.len()).unwrap_or(0);
                TestProviderResult {
                    success: true,
                    dimension: dim,
                    latency_ms,
                    error: None,
                }
            }
            Err(e) => {
                let latency_ms = start.elapsed().as_millis() as u64;
                TestProviderResult {
                    success: false,
                    dimension: 0,
                    latency_ms,
                    error: Some(e),
                }
            }
        }
    }
}

pub struct EmbeddingService {
    local_embedder: Option<LocalOnnxEmbedder>,
    openai_embedder: OpenAiEmbedder,
}

impl EmbeddingService {
    pub fn new(local_embedder: Option<LocalOnnxEmbedder>) -> Self {
        Self {
            local_embedder,
            openai_embedder: OpenAiEmbedder::new(),
        }
    }

    pub fn local_loaded(&self) -> bool {
        self.local_embedder.is_some()
    }

    pub fn local_model_name(&self) -> &str {
        self.local_embedder
            .as_ref()
            .map(|e| e.model_name())
            .unwrap_or("Unavailable")
    }

    pub async fn generate_embeddings(
        &self,
        texts: &[&str],
        settings: &AppSettings,
    ) -> Result<Vec<Vec<f32>>, String> {
        match settings.provider {
            EmbeddingProviderType::Local => {
                if let Some(local) = &self.local_embedder {
                    tokio::task::block_in_place(|| local.embed_batch(texts))
                } else {
                    Err("Local ONNX embedder is not loaded".to_string())
                }
            }
            EmbeddingProviderType::Openai => {
                let str_texts: Vec<String> = texts.iter().map(|s| s.to_string()).collect();
                let dims = if settings.openai_dimensions > 0 {
                    Some(settings.openai_dimensions)
                } else {
                    None
                };
                self.openai_embedder
                    .embed_batch(
                        &settings.openai_base_url,
                        &settings.openai_api_key,
                        &settings.openai_model,
                        dims,
                        &str_texts,
                    )
                    .await
            }
        }
    }

    pub async fn generate_single(
        &self,
        text: &str,
        settings: &AppSettings,
    ) -> Result<Vec<f32>, String> {
        let results = self.generate_embeddings(&[text], settings).await?;
        results
            .into_iter()
            .next()
            .ok_or_else(|| "Empty embeddings returned".to_string())
    }

    pub async fn test_openai_settings(&self, settings: &AppSettings) -> TestProviderResult {
        let dims = if settings.openai_dimensions > 0 {
            Some(settings.openai_dimensions)
        } else {
            None
        };
        self.openai_embedder
            .test_connection(
                &settings.openai_base_url,
                &settings.openai_api_key,
                &settings.openai_model,
                dims,
            )
            .await
    }
}
