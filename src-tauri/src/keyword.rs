use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const CODE_STOP_WORDS: &[&str] = &[
    "abstract",
    "arguments",
    "array",
    "assert",
    "async",
    "await",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "double",
    "else",
    "enum",
    "eval",
    "export",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "function",
    "goto",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "int",
    "interface",
    "let",
    "long",
    "native",
    "new",
    "null",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "true",
    "try",
    "typeof",
    "var",
    "void",
    "volatile",
    "while",
    "with",
    "yield",
    "none",
    "self",
    "struct",
    "impl",
    "trait",
    "pub",
    "mut",
    "fn",
    "match",
    "loop",
    "mod",
    "use",
    "crate",
];

fn stop_words() -> &'static HashSet<&'static str> {
    static STOP_WORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();

    STOP_WORDS.get_or_init(|| {
        stop_words::get(stop_words::LANGUAGE::English)
            .iter()
            .copied()
            .chain(CODE_STOP_WORDS.iter().copied())
            .collect()
    })
}

pub fn extract_keywords(title: &str, content: &str, max_keywords: usize) -> Vec<String> {
    let stop_words = stop_words();
    let mut word_scores: HashMap<String, f32> = HashMap::new();

    // Clean text by stripping markdown code blocks, links, formatting
    let clean_title = clean_markdown(title);
    let clean_content = clean_markdown(content);

    // Title words get higher weight (weight 3.0)
    for word in tokenize(&clean_title) {
        if word.len() >= 3
            && !stop_words.contains(word.as_str())
            && !word.chars().all(|c| c.is_ascii_digit())
        {
            *word_scores.entry(word).or_insert(0.0) += 3.0;
        }
    }

    // Content words (weight 1.0)
    for word in tokenize(&clean_content) {
        if word.len() >= 3
            && !stop_words.contains(word.as_str())
            && !word.chars().all(|c| c.is_ascii_digit())
        {
            *word_scores.entry(word).or_insert(0.0) += 1.0;
        }
    }

    // Rank words by score descending
    let mut entries: Vec<(String, f32)> = word_scores.into_iter().collect();
    entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    entries
        .into_iter()
        .take(max_keywords)
        .map(|(word, _)| word)
        .collect()
}

fn clean_markdown(text: &str) -> String {
    // Replace markdown symbols with space
    let mut result = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            result.push(c);
        } else {
            result.push(' ');
        }
    }
    result
}

fn tokenize(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}
