use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::ffi::sqlite3_auto_extension;
use rusqlite::{params, Connection, OptionalExtension};
use sqlite_vec::sqlite3_vec_init;
use uuid::Uuid;

use crate::models::{
    AppSettings, Collection, DatabaseInfo, SearchFilter, SearchResult, Snippet, TextImportJob,
};

pub struct PendingTextImportJob {
    pub id: String,
    pub source_paths: Vec<String>,
    pub files: Option<Vec<String>>,
    pub collection_id: String,
    pub processed_count: usize,
    pub imported_count: usize,
    pub skipped_count: usize,
    pub failed_count: usize,
}

pub struct Database {
    conn: Mutex<Connection>,
    db_path: Mutex<PathBuf>,
}

fn remove_database_files(db_path: &Path) {
    let _ = std::fs::remove_file(db_path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = db_path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(sidecar));
    }
}

fn database_sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut sidecar = db_path.as_os_str().to_os_string();
    sidecar.push(suffix);
    PathBuf::from(sidecar)
}

impl Database {
    pub fn init(db_path: &Path) -> Result<Self, String> {
        // Register sqlite-vec extension auto-load
        unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
        }

        let conn = Self::open_connection(db_path)?;
        let db = Self {
            conn: Mutex::new(conn),
            db_path: Mutex::new(db_path.to_path_buf()),
        };
        db.migrate()?;
        Ok(db)
    }

    fn open_connection(db_path: &Path) -> Result<Connection, String> {
        let conn = Connection::open(db_path)
            .map_err(|e| format!("Failed to open database at {}: {e}", db_path.display()))?;

        // Enable WAL mode and foreign keys for performance and safety
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| format!("Failed to configure database: {e}"))?;

        Ok(conn)
    }

    pub fn db_path(&self) -> PathBuf {
        self.db_path
            .lock()
            .map(|path| path.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    pub fn get_database_info(&self) -> DatabaseInfo {
        let db_path = self.db_path();
        let filename = db_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("snippets.sqlite3")
            .to_string();

        let mut size_bytes = std::fs::metadata(&db_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let mut wal_path = db_path.as_os_str().to_os_string();
        wal_path.push("-wal");
        if let Ok(m) = std::fs::metadata(&wal_path) {
            size_bytes += m.len();
        }

        let mut shm_path = db_path.as_os_str().to_os_string();
        shm_path.push("-shm");
        if let Ok(m) = std::fs::metadata(&shm_path) {
            size_bytes += m.len();
        }

        DatabaseInfo {
            filename,
            size_bytes,
            path: db_path.to_string_lossy().into_owned(),
            directory: db_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_string_lossy()
                .into_owned(),
        }
    }

    pub fn data_dir(&self) -> PathBuf {
        self.db_path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    }

    pub fn checkpoint_wal(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let (busy, _log_frames, _checkpointed_frames): (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("Failed to checkpoint WAL: {e}"))?;
        if busy != 0 {
            return Err("The database is busy and could not be prepared for backup".into());
        }
        Ok(())
    }

    pub fn with_backup_write_lock<T, E>(
        &self,
        action: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<String>,
    {
        let conn = self
            .conn
            .lock()
            .map_err(|e| E::from(format!("Failed to lock DB connection: {e}")))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| E::from(format!("Failed to acquire write lock for backup: {e}")))?;
        let result = action();
        let _ = tx.rollback();
        result
    }

    pub fn close_for_restore(&self) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let mem = Connection::open_in_memory()
            .map_err(|e| format!("Failed to release database file: {e}"))?;
        *conn = mem;
        Ok(())
    }

    pub fn reopen_after_restore(&self) -> Result<(), String> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let db_path = self.db_path();
        let new_conn = Self::open_connection(&db_path)?;
        *conn = new_conn;
        drop(conn);
        self.migrate()?;
        Ok(())
    }

    pub fn relocate<F>(
        &self,
        new_path: &Path,
        overwrite: bool,
        save_preference: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let mut current_path = self
            .db_path
            .lock()
            .map_err(|e| format!("Failed to lock database path: {e}"))?;

        let same_file = new_path == current_path.as_path()
            || match (
                std::fs::canonicalize(new_path),
                std::fs::canonicalize(current_path.as_path()),
            ) {
                (Ok(new_path), Ok(current_path)) => new_path == current_path,
                _ => false,
            };
        if same_file {
            return Ok(());
        }
        if new_path.exists() && !overwrite {
            return Err(format!(
                "STORAGE_FILE_EXISTS:{} already exists. Replace it with the current SnippetBox database?",
                new_path.display()
            ));
        }
        if new_path.is_dir() {
            return Err("The selected storage path is a folder, not a database file".into());
        }

        let parent = new_path
            .parent()
            .ok_or_else(|| "Choose a storage file inside a folder".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create the storage folder: {e}"))?;

        let (busy, _, _): (i64, i64, i64) = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|e| format!("Failed to prepare the database for moving: {e}"))?;
        if busy != 0 {
            return Err("The database is busy and could not be moved".into());
        }

        let suffix = Uuid::new_v4();
        let staging_path = parent.join(format!(".snippetbox-storage-{suffix}.staging"));
        std::fs::copy(current_path.as_path(), &staging_path)
            .map_err(|e| format!("Failed to copy the current database: {e}"))?;

        let mut replaced_files = Vec::new();
        let existing_files = [
            new_path.to_path_buf(),
            database_sidecar_path(new_path, "-wal"),
            database_sidecar_path(new_path, "-shm"),
        ];
        for (index, existing) in existing_files.iter().enumerate() {
            if existing.exists() {
                let replaced = parent.join(format!(
                    ".snippetbox-storage-{suffix}.{index}.replaced"
                ));
                if let Err(error) = std::fs::rename(existing, &replaced) {
                    for (original, replacement) in replaced_files.iter().rev() {
                        let _ = std::fs::rename(replacement, original);
                    }
                    let _ = std::fs::remove_file(&staging_path);
                    return Err(format!(
                        "Failed to prepare the existing storage file: {error}"
                    ));
                }
                replaced_files.push((existing.clone(), replaced));
            }
        }

        if let Err(error) = std::fs::rename(&staging_path, new_path) {
            for (original, replacement) in replaced_files.iter().rev() {
                let _ = std::fs::rename(replacement, original);
            }
            let _ = std::fs::remove_file(&staging_path);
            return Err(format!(
                "Failed to install the database at its new location: {error}"
            ));
        }

        let new_conn = match Self::open_connection(new_path) {
            Ok(new_conn) => new_conn,
            Err(error) => {
                remove_database_files(new_path);
                for (original, replacement) in replaced_files.iter().rev() {
                    let _ = std::fs::rename(replacement, original);
                }
                return Err(error);
            }
        };
        let integrity = new_conn
            .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Failed to verify the moved database: {error}"));
        if !matches!(integrity.as_deref(), Ok("ok")) {
            drop(new_conn);
            remove_database_files(new_path);
            for (original, replacement) in replaced_files.iter().rev() {
                let _ = std::fs::rename(replacement, original);
            }
            return Err(match integrity {
                Ok(result) => format!("The moved database failed its integrity check: {result}"),
                Err(error) => error,
            });
        }

        if let Err(error) = save_preference() {
            drop(new_conn);
            remove_database_files(new_path);
            for (original, replacement) in replaced_files.iter().rev() {
                let _ = std::fs::rename(replacement, original);
            }
            return Err(error);
        }

        *conn = new_conn;
        *current_path = new_path.to_path_buf();
        for (_, replacement) in replaced_files {
            let _ = std::fs::remove_file(replacement);
        }
        Ok(())
    }

    pub fn get_counts(&self) -> Result<(usize, usize), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let snippets: usize = conn
            .query_row("SELECT count(*) FROM snippets;", [], |row| row.get(0))
            .unwrap_or(0);
        let collections: usize = conn
            .query_row("SELECT count(*) FROM collections;", [], |row| row.get(0))
            .unwrap_or(0);
        Ok((snippets, collections))
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        // 1. Collections table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL
            );",
            [],
        )
        .map_err(|e| format!("Failed to create collections table: {e}"))?;

        // Ensure default collection exists
        let default_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id = 'default')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !default_exists {
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO collections (id, name, description, color, created_at)
                 VALUES ('default', 'Default', 'General snippet collection', '#10b981', ?1)",
                params![now],
            )
            .map_err(|e| format!("Failed to create default collection: {e}"))?;
        }

        // 2. Snippets table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS snippets (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                language TEXT NOT NULL,
                collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                tags_json TEXT NOT NULL DEFAULT '[]',
                keywords_json TEXT NOT NULL DEFAULT '[]',
                favorite INTEGER NOT NULL DEFAULT 0,
                copy_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_copied_at TEXT,
                embedding BLOB
            );",
            [],
        )
        .map_err(|e| format!("Failed to create snippets table: {e}"))?;

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snippets_collection ON snippets(collection_id);",
            [],
        )
        .map_err(|e| format!("Failed to create index on snippets: {e}"))?;

        // 3. FTS5 full-text table
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
                snippet_id UNINDEXED,
                title,
                content,
                tags,
                keywords,
                tokenize = 'porter unicode61'
            );",
            [],
        )
        .map_err(|e| format!("Failed to create snippets_fts table: {e}"))?;

        // 5. App Settings table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
            [],
        )
        .map_err(|e| format!("Failed to create app_settings table: {e}"))?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS text_import_jobs (
                id TEXT PRIMARY KEY,
                source_paths_json TEXT NOT NULL,
                files_json TEXT,
                collection_id TEXT NOT NULL,
                status TEXT NOT NULL,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                processed_count INTEGER NOT NULL DEFAULT 0,
                imported_count INTEGER NOT NULL DEFAULT 0,
                skipped_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_text_import_jobs_status
                ON text_import_jobs(status, created_at);
            UPDATE text_import_jobs SET status = 'queued'
                WHERE status IN ('scanning', 'importing');",
        )
        .map_err(|e| format!("Failed to create text import queue: {e}"))?;

        // Rebuild derived text data and discard legacy vectors whose model is unknown.
        conn.execute_batch(
            "BEGIN;
            DELETE FROM snippets_fts;
            INSERT INTO snippets_fts(snippet_id, title, content, tags, keywords)
                SELECT id, title, content, tags_json, keywords_json FROM snippets;
            DROP TABLE IF EXISTS vec_snippets;
            UPDATE snippets SET embedding = NULL WHERE NOT EXISTS
                (SELECT 1 FROM app_settings WHERE key = 'search_index_v2');
            INSERT OR IGNORE INTO app_settings VALUES ('search_index_v2', '1');
            COMMIT;",
        )
        .map_err(|e| format!("Failed to rebuild search index: {e}"))?;

        Ok(())
    }

    pub fn save_snippet(&self, snippet: &Snippet, embedding: Option<&[f32]>) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let conn = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        if let Some(vector) = embedding {
            crate::embedding::validate_embedding(vector)?;
        }
        let tags_json = serde_json::to_string(&snippet.tags).unwrap_or_else(|_| "[]".to_string());
        let keywords_json =
            serde_json::to_string(&snippet.keywords).unwrap_or_else(|_| "[]".to_string());

        let raw_blob: Option<Vec<u8>> = embedding.map(|vec| {
            let mut bytes = Vec::with_capacity(vec.len() * 4);
            for f in vec {
                bytes.extend_from_slice(&f.to_le_bytes());
            }
            bytes
        });

        conn.execute(
            "INSERT INTO snippets (
                id, title, content, language, collection_id, tags_json, keywords_json,
                favorite, copy_count, created_at, updated_at, last_copied_at, embedding
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                content = excluded.content,
                language = excluded.language,
                collection_id = excluded.collection_id,
                tags_json = excluded.tags_json,
                keywords_json = excluded.keywords_json,
                favorite = excluded.favorite,
                copy_count = excluded.copy_count,
                updated_at = excluded.updated_at,
                last_copied_at = excluded.last_copied_at,
                embedding = excluded.embedding;",
            params![
                snippet.id,
                snippet.title,
                snippet.content,
                snippet.language,
                snippet.collection_id,
                tags_json,
                keywords_json,
                if snippet.favorite { 1 } else { 0 },
                snippet.copy_count,
                snippet.created_at,
                snippet.updated_at,
                snippet.last_copied_at,
                raw_blob,
            ],
        )
        .map_err(|e| format!("Failed to save snippet: {e}"))?;

        // Sync FTS5
        conn.execute(
            "DELETE FROM snippets_fts WHERE snippet_id = ?1;",
            params![snippet.id],
        )
        .map_err(|e| e.to_string())?;
        let tags_str = snippet.tags.join(" ");
        let keywords_str = snippet.keywords.join(" ");
        conn.execute(
            "INSERT INTO snippets_fts (snippet_id, title, content, tags, keywords)
             VALUES (?1, ?2, ?3, ?4, ?5);",
            params![
                snippet.id,
                snippet.title,
                snippet.content,
                tags_str,
                keywords_str,
            ],
        )
        .map_err(|e| format!("Failed to update FTS5: {e}"))?;

        conn.commit()
            .map_err(|e| format!("Failed to commit snippet: {e}"))?;

        Ok(())
    }

    pub fn snippets_needing_embeddings(&self) -> Result<Vec<Snippet>, String> {
        let snippets = self.list_snippets()?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM snippets WHERE embedding IS NULL")
            .map_err(|e| e.to_string())?;
        let ids: HashSet<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        Ok(snippets
            .into_iter()
            .filter(|s| ids.contains(&s.id))
            .collect())
    }

    pub fn get_snippet_embedding(&self, id: &str) -> Result<Option<Vec<f32>>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let blob: Option<Vec<u8>> = conn
            .query_row(
                "SELECT embedding FROM snippets WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("Failed to load snippet embedding: {e}"))?
            .flatten();

        blob.map(|bytes| {
            if bytes.len() % 4 != 0 {
                return Err("Stored snippet embedding is invalid".to_string());
            }
            let vector = bytes
                .chunks_exact(4)
                .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("four-byte chunk")))
                .collect::<Vec<_>>();
            crate::embedding::validate_embedding(&vector)?;
            Ok(vector)
        })
        .transpose()
    }

    pub fn get_snippet(&self, id: &str) -> Result<Option<Snippet>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, title, content, language, collection_id, tags_json, keywords_json,
                        favorite, copy_count, created_at, updated_at, last_copied_at
                 FROM snippets WHERE id = ?1;",
            )
            .map_err(|e| format!("Failed to prepare get_snippet statement: {e}"))?;

        let snippet = stmt
            .query_row(params![id], |row| {
                let tags_raw: String = row.get(5)?;
                let keywords_raw: String = row.get(6)?;
                let favorite_num: i32 = row.get(7)?;

                Ok(Snippet {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    language: row.get(3)?,
                    collection_id: row.get(4)?,
                    tags: serde_json::from_str(&tags_raw).unwrap_or_default(),
                    keywords: serde_json::from_str(&keywords_raw).unwrap_or_default(),
                    favorite: favorite_num != 0,
                    copy_count: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    last_copied_at: row.get(11)?,
                })
            })
            .optional()
            .map_err(|e| format!("Failed to query snippet: {e}"))?;

        Ok(snippet)
    }

    pub fn list_snippets(&self) -> Result<Vec<Snippet>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, title, content, language, collection_id, tags_json, keywords_json,
                        favorite, copy_count, created_at, updated_at, last_copied_at
                 FROM snippets ORDER BY created_at DESC;",
            )
            .map_err(|e| format!("Failed to prepare list_snippets statement: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                let tags_raw: String = row.get(5)?;
                let keywords_raw: String = row.get(6)?;
                let favorite_num: i32 = row.get(7)?;

                Ok(Snippet {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    language: row.get(3)?,
                    collection_id: row.get(4)?,
                    tags: serde_json::from_str(&tags_raw).unwrap_or_default(),
                    keywords: serde_json::from_str(&keywords_raw).unwrap_or_default(),
                    favorite: favorite_num != 0,
                    copy_count: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                    last_copied_at: row.get(11)?,
                })
            })
            .map_err(|e| format!("Failed to query snippets: {e}"))?;

        let mut list = Vec::new();
        for r in rows {
            list.push(r.map_err(|e| format!("Failed to read snippet: {e}"))?);
        }
        Ok(list)
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let conn = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM snippets WHERE id = ?1;", params![id])
            .map_err(|e| format!("Failed to delete snippet from table: {e}"))?;
        conn.execute(
            "DELETE FROM snippets_fts WHERE snippet_id = ?1;",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.commit().map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn batch_delete_snippets(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        for id in ids {
            tx.execute("DELETE FROM snippets WHERE id = ?1;", params![id])
                .map_err(|e| format!("Failed to delete snippet from table: {e}"))?;
            tx.execute(
                "DELETE FROM snippets_fts WHERE snippet_id = ?1;",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_copy(&self, id: &str) -> Result<u32, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE snippets
             SET copy_count = copy_count + 1, last_copied_at = ?1
             WHERE id = ?2;",
            params![now, id],
        )
        .map_err(|e| format!("Failed to record snippet copy: {e}"))?;

        let count: u32 = conn
            .query_row(
                "SELECT copy_count FROM snippets WHERE id = ?1;",
                params![id],
                |row| row.get(0),
            )
            .unwrap_or(1);

        Ok(count)
    }

    pub fn toggle_favorite(&self, id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let current: i32 = conn
            .query_row(
                "SELECT favorite FROM snippets WHERE id = ?1;",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Snippet not found: {e}"))?;

        let new_val = if current == 0 { 1 } else { 0 };
        conn.execute(
            "UPDATE snippets SET favorite = ?1 WHERE id = ?2;",
            params![new_val, id],
        )
        .map_err(|e| format!("Failed to update favorite: {e}"))?;

        Ok(new_val == 1)
    }

    pub fn set_snippets_favorite(&self, ids: &[String], favorite: bool) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let new_val = if favorite { 1 } else { 0 };

        for id in ids {
            tx.execute(
                "UPDATE snippets SET favorite = ?1 WHERE id = ?2;",
                params![new_val, id],
            )
            .map_err(|e| format!("Failed to update favorite: {e}"))?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn tag_snippets(
        &self,
        ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }

        let add = normalize_tags(add);
        let remove: HashSet<String> = normalize_tags(remove).into_iter().collect();

        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();

        for id in ids {
            let row = tx
                .query_row(
                    "SELECT title, content, tags_json, keywords_json FROM snippets WHERE id = ?1;",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| format!("Failed to load snippet tags: {e}"))?;

            let Some((title, content, tags_raw, keywords_raw)) = row else {
                continue;
            };

            let mut tags = normalize_tags(
                &serde_json::from_str::<Vec<String>>(&tags_raw).unwrap_or_default(),
            );
            tags.retain(|tag| !remove.contains(tag));

            let existing: HashSet<String> = tags.iter().cloned().collect();
            for tag in &add {
                if !existing.contains(tag) {
                    tags.push(tag.clone());
                }
            }

            let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
            tx.execute(
                "UPDATE snippets SET tags_json = ?1, updated_at = ?2 WHERE id = ?3;",
                params![tags_json, now, id],
            )
            .map_err(|e| format!("Failed to update snippet tags: {e}"))?;

            tx.execute(
                "DELETE FROM snippets_fts WHERE snippet_id = ?1;",
                params![id],
            )
            .map_err(|e| e.to_string())?;

            let keywords: Vec<String> =
                serde_json::from_str(&keywords_raw).unwrap_or_default();
            tx.execute(
                "INSERT INTO snippets_fts (snippet_id, title, content, tags, keywords)
                 VALUES (?1, ?2, ?3, ?4, ?5);",
                params![id, title, content, tags.join(" "), keywords.join(" ")],
            )
            .map_err(|e| format!("Failed to update FTS5: {e}"))?;
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn move_snippets(&self, ids: &[String], collection_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1);",
                params![collection_id],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !exists {
            return Err("Target collection does not exist".to_string());
        }

        for id in ids {
            let _ = conn.execute(
                "UPDATE snippets SET collection_id = ?1 WHERE id = ?2;",
                params![collection_id, id],
            );
        }

        Ok(())
    }

    // Collection validation shared by moves and queued imports
    pub fn collection_exists(&self, id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1);",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to validate collection: {e}"))
    }

    // Text import queue
    pub fn enqueue_text_import_job(
        &self,
        id: &str,
        paths: &[String],
        collection_id: &str,
    ) -> Result<TextImportJob, String> {
        let now = Utc::now().to_rfc3339();
        let paths_json = serde_json::to_string(paths)
            .map_err(|e| format!("Failed to prepare import paths: {e}"))?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        conn.execute(
            "INSERT INTO text_import_jobs (
                id, source_paths_json, collection_id, status, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'queued', ?4, ?4);",
            params![id, paths_json, collection_id, now],
        )
        .map_err(|e| format!("Failed to queue text import: {e}"))?;
        Ok(TextImportJob {
            id: id.to_string(),
            status: "queued".to_string(),
            collection_id: collection_id.to_string(),
            discovered_count: 0,
            processed_count: 0,
            imported_count: 0,
            skipped_count: 0,
            failed_count: 0,
            error: None,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn claim_next_text_import_job(&self) -> Result<Option<PendingTextImportJob>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;
        let row = conn
            .query_row(
                "SELECT id, source_paths_json, files_json, collection_id, processed_count,
                        imported_count, skipped_count, failed_count
                 FROM text_import_jobs WHERE status = 'queued'
                 ORDER BY created_at ASC LIMIT 1;",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, usize>(4)?,
                        row.get::<_, usize>(5)?,
                        row.get::<_, usize>(6)?,
                        row.get::<_, usize>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("Failed to load queued text import: {e}"))?;
        let Some((id, source_paths_json, files_json, collection_id, processed_count, imported_count, skipped_count, failed_count)) = row else {
            return Ok(None);
        };
        let now = Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE text_import_jobs SET status = 'scanning', updated_at = ?2
                 WHERE id = ?1 AND status = 'queued';",
                params![id, now],
            )
            .map_err(|e| format!("Failed to claim text import: {e}"))?;
        if changed == 0 {
            return Ok(None);
        }
        Ok(Some(PendingTextImportJob {
            id,
            source_paths: serde_json::from_str(&source_paths_json)
                .map_err(|e| format!("Invalid queued import paths: {e}"))?,
            files: files_json
                .map(|json| serde_json::from_str(&json))
                .transpose()
                .map_err(|e| format!("Invalid queued import file list: {e}"))?,
            collection_id,
            processed_count,
            imported_count,
            skipped_count,
            failed_count,
        }))
    }

    pub fn has_queued_text_import_jobs(&self) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM text_import_jobs WHERE status = 'queued');",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to inspect text import queue: {e}"))
    }

    pub fn text_import_job_is_active(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM text_import_jobs
                WHERE id = ?1 AND status IN ('scanning', 'importing')
            );",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to validate text import job: {e}"))
    }

    pub fn set_text_import_files(
        &self,
        id: &str,
        files: &[String],
        skipped_count: usize,
        failed_count: usize,
    ) -> Result<(), String> {
        let files_json = serde_json::to_string(files)
            .map_err(|e| format!("Failed to store import file list: {e}"))?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE text_import_jobs SET files_json = ?2, status = 'importing',
                    discovered_count = ?3, skipped_count = ?4, failed_count = ?5,
                    updated_at = ?6 WHERE id = ?1;",
            params![id, files_json, files.len(), skipped_count, failed_count, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Failed to update import scan: {e}"))?;
        Ok(())
    }

    pub fn update_text_import_progress(
        &self,
        id: &str,
        processed_count: usize,
        imported_count: usize,
        skipped_count: usize,
        failed_count: usize,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE text_import_jobs SET status = 'importing', processed_count = ?2,
                    imported_count = ?3, skipped_count = ?4, failed_count = ?5,
                    updated_at = ?6 WHERE id = ?1;",
            params![id, processed_count, imported_count, skipped_count, failed_count, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Failed to save import progress: {e}"))?;
        Ok(())
    }

    pub fn finish_text_import_job(&self, id: &str, error: Option<&str>) -> Result<(), String> {
        let status = if error.is_some() { "failed" } else { "completed" };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE text_import_jobs SET status = ?2, error = ?3, updated_at = ?4
             WHERE id = ?1 AND status IN ('scanning', 'importing');",
            params![id, status, error, Utc::now().to_rfc3339()],
        )
        .map_err(|e| format!("Failed to finish import job: {e}"))?;
        Ok(())
    }

    pub fn list_text_import_jobs(&self) -> Result<Vec<TextImportJob>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut statement = conn
            .prepare(
                "SELECT id, status, collection_id, discovered_count, processed_count,
                        imported_count, skipped_count, failed_count, error, created_at, updated_at
                 FROM text_import_jobs
                 WHERE status IN ('queued', 'scanning', 'importing')
                    OR id IN (
                        SELECT id FROM text_import_jobs
                        WHERE status IN ('completed', 'failed')
                        ORDER BY updated_at DESC LIMIT 10
                    )
                 ORDER BY created_at DESC;",
            )
            .map_err(|e| format!("Failed to prepare import status: {e}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(TextImportJob {
                    id: row.get(0)?,
                    status: row.get(1)?,
                    collection_id: row.get(2)?,
                    discovered_count: row.get(3)?,
                    processed_count: row.get(4)?,
                    imported_count: row.get(5)?,
                    skipped_count: row.get(6)?,
                    failed_count: row.get(7)?,
                    error: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("Failed to load import status: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to read import status: {e}"))
    }

    // Collections
    pub fn list_collections(&self) -> Result<Vec<Collection>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let mut stmt = conn
            .prepare("SELECT id, name, description, color, created_at FROM collections ORDER BY name ASC;")
            .map_err(|e| format!("Failed to prepare collections statement: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    color: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| format!("Failed to query collections: {e}"))?;

        let mut list = Vec::new();
        for r in rows {
            if let Ok(c) = r {
                list.push(c);
            }
        }
        Ok(list)
    }

    pub fn save_collection(&self, col: &Collection) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        conn.execute(
            "INSERT INTO collections (id, name, description, color, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                color = excluded.color;",
            params![col.id, col.name, col.description, col.color, col.created_at],
        )
        .map_err(|e| format!("Failed to save collection: {e}"))?;

        Ok(())
    }

    pub fn delete_collection(&self, id: &str) -> Result<(), String> {
        if id == "default" {
            return Err("Cannot delete the default collection".to_string());
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        // Reassign snippets in this collection to default
        let _ = conn.execute(
            "UPDATE snippets SET collection_id = 'default' WHERE collection_id = ?1;",
            params![id],
        );

        conn.execute("DELETE FROM collections WHERE id = ?1;", params![id])
            .map_err(|e| format!("Failed to delete collection: {e}"))?;

        Ok(())
    }

    // Tags & Keywords
    pub fn get_all_tags(&self) -> Result<Vec<String>, String> {
        let snippets = self.list_snippets()?;
        let mut set = HashSet::new();
        for s in snippets {
            for t in s.tags {
                if !t.trim().is_empty() {
                    set.insert(t);
                }
            }
        }
        let mut list: Vec<String> = set.into_iter().collect();
        list.sort();
        Ok(list)
    }

    pub fn get_all_keywords(&self) -> Result<Vec<String>, String> {
        let snippets = self.list_snippets()?;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for s in snippets {
            for k in s.keywords {
                if !k.trim().is_empty() {
                    *counts.entry(k).or_insert(0) += 1;
                }
            }
        }
        let mut list: Vec<(String, usize)> = counts.into_iter().collect();
        list.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(list.into_iter().take(50).map(|(k, _)| k).collect())
    }

    // Settings
    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let json: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'settings';",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None);

        if let Some(raw) = json {
            serde_json::from_str(&raw).map_err(|e| format!("Failed to parse settings: {e}"))
        } else {
            Ok(AppSettings::default())
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        let conn = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let previous: Option<String> = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let previous: AppSettings = previous
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if previous.provider != settings.provider
            || previous.openai_base_url != settings.openai_base_url
            || previous.openai_model != settings.openai_model
            || previous.openai_dimensions != settings.openai_dimensions
        {
            conn.execute("UPDATE snippets SET embedding = NULL", [])
                .map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string(settings)
            .map_err(|e| format!("Failed to serialize settings: {e}"))?;

        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![json],
        )
        .map_err(|e| format!("Failed to save settings: {e}"))?;

        conn.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    // Hybrid Search
    pub fn hybrid_search(
        &self,
        filter: &SearchFilter,
        query_embedding: Option<&[f32]>,
    ) -> Result<Vec<SearchResult>, String> {
        let query_text = filter.query.as_deref().unwrap_or("").trim();
        let all_snippets: Vec<_> = self
            .list_snippets()?
            .into_iter()
            .filter(|s| filter_matches(s, filter))
            .collect();

        // If no query string and no vector, simply filter and sort
        if query_text.is_empty() {
            let mut matched: Vec<SearchResult> = all_snippets
                .into_iter()
                .filter(|s| filter_matches(s, filter))
                .map(|s| SearchResult {
                    snippet: s,
                    score: 1.0,
                    vector_score: None,
                    keyword_score: None,
                    highlight: None,
                })
                .collect();

            let sort_key = if filter.sort_by == "relevance" || filter.sort_by.is_empty() {
                "created_desc"
            } else {
                &filter.sort_by
            };
            sort_results(&mut matched, sort_key);
            if let Some(limit) = filter.limit {
                matched.truncate(limit);
            }
            return Ok(matched);
        }

        let mode = filter.search_mode.to_lowercase();
        let conn = self
            .conn
            .lock()
            .map_err(|e| format!("Failed to lock DB connection: {e}"))?;

        if !matches!(mode.as_str(), "hybrid" | "semantic" | "keyword") {
            return Err(format!("Unknown search mode: {mode}"));
        }
        let eligible: HashSet<&str> = all_snippets.iter().map(|s| s.id.as_str()).collect();
        let mut vector_ranks = HashMap::new();
        if mode == "semantic" || mode == "hybrid" {
            let query = query_embedding
                .ok_or("Semantic search unavailable: check the embedding provider")?;
            crate::embedding::validate_embedding(query)?;
            let mut stmt = conn
                .prepare("SELECT id, embedding FROM snippets WHERE embedding IS NOT NULL")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| e.to_string())?;
            let mut scores = Vec::new();
            for row in rows {
                let (id, blob) = row.map_err(|e| e.to_string())?;
                if !eligible.contains(id.as_str()) {
                    continue;
                }
                if blob.len() != query.len() * 4 {
                    return Err(
                        "Embedding dimensions changed. Reindex embeddings in Settings.".into(),
                    );
                }
                let vector: Vec<f32> = blob
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                crate::embedding::validate_embedding(&vector)?;
                let dot: f64 = vector
                    .iter()
                    .zip(query)
                    .map(|(a, b)| *a as f64 * *b as f64)
                    .sum();
                let norm = |v: &[f32]| v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
                let similarity = (dot / (norm(&vector) * norm(query))).clamp(-1.0, 1.0) as f32;
                if similarity > 0.0 {
                    scores.push((id, similarity));
                }
            }
            let missing: usize = conn
                .query_row(
                    "SELECT count(*) FROM snippets WHERE embedding IS NULL",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if missing > 0 {
                return Err(format!(
                    "{missing} snippets need embeddings. Run Reindex in Settings."
                ));
            }
            scores.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            for (i, (id, score)) in scores.into_iter().enumerate() {
                vector_ranks.insert(id, (i + 1, score));
            }
        }

        let mut fts_ranks = HashMap::new();
        if mode == "hybrid" || mode == "keyword" {
            let fts_query = sanitize_fts5_query(query_text);
            if !fts_query.is_empty() {
                let mut stmt = conn
                    .prepare(
                        "SELECT snippet_id, bm25(snippets_fts, 0, 3, 1, 2, 2),
                     snippet(snippets_fts, 2, '<mark>', '</mark>', '...', 24)
                     FROM snippets_fts WHERE snippets_fts MATCH ?1
                     ORDER BY 2 ASC, snippet_id ASC",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![fts_query], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, f32>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let (id, score, highlight) = row.map_err(|e| e.to_string())?;
                    if !eligible.contains(id.as_str()) {
                        continue;
                    }
                    let rank = fts_ranks.len() + 1;
                    fts_ranks.insert(id, (rank, -score, highlight));
                }
                let best = fts_ranks
                    .values()
                    .map(|(_, score, _)| *score)
                    .fold(0.0_f32, f32::max);
                if best > 0.0 {
                    for (_, score, _) in fts_ranks.values_mut() {
                        *score /= best;
                    }
                }
            }
        }

        // 3. Fallback content substring matching if FTS5 returned few or no results
        if fts_ranks.is_empty() && (mode == "hybrid" || mode == "keyword") {
            let lower_q = query_text.to_lowercase();
            let mut rank = 1;
            for snip in &all_snippets {
                if snip.title.to_lowercase().contains(&lower_q)
                    || snip.content.to_lowercase().contains(&lower_q)
                    || snip
                        .tags
                        .iter()
                        .any(|t| t.to_lowercase().contains(&lower_q))
                {
                    fts_ranks.insert(snip.id.clone(), (rank, 0.5, None));
                    rank += 1;
                }
            }
        }

        // 4. Combine scores using Reciprocal Rank Fusion (RRF)
        let rrf_k = 60.0f32;
        let mut results: Vec<SearchResult> = Vec::new();
        let snippet_map: HashMap<String, Snippet> = all_snippets
            .into_iter()
            .map(|s| (s.id.clone(), s))
            .collect();

        let mut candidate_ids: HashSet<String> = HashSet::new();
        for id in vector_ranks.keys() {
            candidate_ids.insert(id.clone());
        }
        for id in fts_ranks.keys() {
            candidate_ids.insert(id.clone());
        }

        for id in candidate_ids {
            if let Some(snippet) = snippet_map.get(&id) {
                if !filter_matches(snippet, filter) {
                    continue;
                }

                let v_info = vector_ranks.get(&id);
                let f_info = fts_ranks.get(&id);

                let v_score = v_info.map(|v| v.1);
                let f_score = f_info.map(|f| f.1);
                let highlight = f_info.and_then(|f| f.2.clone());

                let final_score = match mode.as_str() {
                    "semantic" => v_score.unwrap_or(0.0),
                    "keyword" => f_score.unwrap_or(0.0),
                    _ => {
                        // Hybrid: reciprocal rank fusion normalized to [0.0, 1.0]
                        // Max possible raw RRF score occurs when a document is rank 1 in both channels:
                        let max_rrf = 2.0 / (rrf_k + 1.0);
                        let mut rrf_score = 0.0f32;
                        if let Some((rank, _)) = v_info {
                            rrf_score += 1.0 / (rrf_k + (*rank as f32));
                        }
                        if let Some((rank, _, _)) = f_info {
                            rrf_score += 1.0 / (rrf_k + (*rank as f32));
                        }
                        let rrf_norm = (rrf_score / max_rrf).clamp(0.0, 1.0);

                        rrf_norm
                    }
                };

                results.push(SearchResult {
                    snippet: snippet.clone(),
                    score: final_score,
                    vector_score: v_score,
                    keyword_score: f_score,
                    highlight,
                });
            }
        }

        // Sort results: by final_score descending if hybrid/semantic/keyword, or by filter.sort_by if requested
        if filter.sort_by == "relevance" || filter.sort_by.is_empty() {
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.snippet.created_at.cmp(&a.snippet.created_at))
            });
        } else {
            sort_results(&mut results, &filter.sort_by);
        }

        if let Some(limit) = filter.limit {
            results.truncate(limit);
        }

        Ok(results)
    }
}

fn filter_matches(snippet: &Snippet, filter: &SearchFilter) -> bool {
    // Collection filter (multi-select)
    if let Some(col_ids) = &filter.collection_ids {
        if !col_ids.is_empty() && !col_ids.contains(&snippet.collection_id) {
            return false;
        }
    }

    // Tags filter (multi-select: snippet must match at least one of selected tags)
    if let Some(tags) = &filter.tags {
        if !tags.is_empty() {
            let has_tag = tags.iter().any(|t| snippet.tags.contains(t));
            if !has_tag {
                return false;
            }
        }
    }

    // Languages filter (multi-select)
    if let Some(langs) = &filter.languages {
        if !langs.is_empty() {
            let has_lang = langs
                .iter()
                .any(|l| l.eq_ignore_ascii_case(&snippet.language));
            if !has_lang {
                return false;
            }
        }
    }

    // Favorites only
    if let Some(fav_only) = filter.favorite_only {
        if fav_only && !snippet.favorite {
            return false;
        }
    }

    // Date range
    if let Some(from) = &filter.date_from {
        if !from.is_empty() && snippet.created_at.as_str() < from.as_str() {
            return false;
        }
    }
    if let Some(to) = &filter.date_to {
        if !to.is_empty() {
            let to_bound = format!("{to}T23:59:59Z");
            if snippet.created_at.as_str() > to_bound.as_str() {
                return false;
            }
        }
    }

    true
}

fn sort_results(results: &mut [SearchResult], sort_by: &str) {
    match sort_by {
        "relevance" => {
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.snippet.created_at.cmp(&a.snippet.created_at))
            });
        }
        "created_asc" => {
            results.sort_by(|a, b| a.snippet.created_at.cmp(&b.snippet.created_at));
        }
        "created_desc" => {
            results.sort_by(|a, b| b.snippet.created_at.cmp(&a.snippet.created_at));
        }
        "updated_desc" => {
            results.sort_by(|a, b| b.snippet.updated_at.cmp(&a.snippet.updated_at));
        }
        "title_asc" => {
            results.sort_by(|a, b| {
                a.snippet
                    .title
                    .to_lowercase()
                    .cmp(&b.snippet.title.to_lowercase())
            });
        }
        "copies_desc" => {
            results.sort_by(|a, b| b.snippet.copy_count.cmp(&a.snippet.copy_count));
        }
        _ => {
            results.sort_by(|a, b| {
                b.score
                    .partial_cmp(&a.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| b.snippet.created_at.cmp(&a.snippet.created_at))
            });
        }
    }
}

fn sanitize_fts5_query(query: &str) -> String {
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();

    if words.is_empty() {
        return String::new();
    }

    // Format as word1* AND word2* or word1* OR word2*
    words
        .into_iter()
        .map(|w| format!("\"{w}\"*"))
        .collect::<Vec<String>>()
        .join(" OR ")
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}
