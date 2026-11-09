//! What the engine knows of the application's schema: its tables, their indexes and search indexes, as JavaScript describes them at `migrate`. The validators
//! (what a field may hold) stay in JavaScript; this is the shape the database needs: where a document is kept, which fields are indexed and in what order.

use crate::validate::Validator;
use indexmap::IndexMap;
use serde::Deserialize;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Deserialize, Clone)]
pub struct IndexSpec {
    pub fields: Vec<String>,
    /// The index's name in the database (a hash of its definition: changing the fields makes a new index).
    pub sql: String,
}

#[derive(Deserialize, Clone)]
pub struct SearchSpec {
    pub field: String,
    /// The FTS5 table that holds the words.
    pub fts: String,
}

#[derive(Deserialize, Clone)]
pub struct TableSpec {
    pub name: String,
    /// The implicit index by creation time (the order of a query with no index).
    pub creation: IndexSpec,
    pub indexes: Vec<(String, IndexSpec)>,
    #[serde(default)]
    pub search: Vec<(String, SearchSpec)>,
    /// The fields' validators (plain data), when the schema has them: the engine then checks writes itself and sends JavaScript only what it cannot vouch for.
    #[serde(default)]
    pub fields: Option<IndexMap<String, Validator>>,
    /// A table with validators checks every write; a loose one keeps whatever it is given; when JavaScript did not say (no `strict`), every write goes to its schema.
    #[serde(default)]
    pub strict: Option<bool>,
    /// The statements a write makes, written once (the engine fills them in when it takes the schema).
    #[serde(skip)]
    pub stmts: Stmts,
}

/// The statements by document that the engine runs for one table.
#[derive(Clone, Default)]
pub struct Stmts {
    pub insert: String,
    pub doc: String,
    pub update: String,
    pub delete: String,
}

impl Stmts {
    pub fn of(table: &str) -> Self {
        Stmts {
            insert: format!("INSERT INTO \"{table}\" (\"_id\", \"_creationTime\", \"doc\") VALUES (?1, ?2, ?3)"),
            doc: format!("SELECT \"doc\" FROM \"{table}\" WHERE \"_id\" = ?1"),
            update: format!("UPDATE \"{table}\" SET \"doc\" = ?1 WHERE \"_id\" = ?2"),
            delete: format!("DELETE FROM \"{table}\" WHERE \"_id\" = ?1"),
        }
    }
}

impl TableSpec {
    /// The fields of an index (`by_creation_time` and the absence of an index are `_creationTime`), for the order key.
    pub fn clone_fields(&self, name: Option<&str>) -> Option<Vec<String>> {
        self.index_fields(name)
    }

    /// The fields of a named index; empty when there is none.
    pub fn clone_index_fields(&self, name: &str) -> Vec<String> {
        self.index_fields(Some(name)).unwrap_or_default()
    }

    /// The fields of an index by name (`by_creation_time` and the absence of an index are `_creationTime`).
    pub fn index_fields(&self, name: Option<&str>) -> Option<Vec<String>> {
        match name {
            None | Some("by_creation_time") => Some(vec!["_creationTime".to_string()]),
            Some(n) => self.indexes.iter().find(|(k, _)| k == n).map(|(_, s)| s.fields.clone()),
        }
    }
}

#[derive(Default)]
pub struct Schema {
    pub tables: HashMap<String, Rc<TableSpec>>,
}

/// A field name that may be part of SQL text (a JSON path): `_id`, `_creationTime`, or a plain identifier.
pub fn safe_field(f: &str) -> bool {
    if f == "_id" || f == "_creationTime" {
        return true;
    }
    let mut chars = f.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    f.len() <= 100 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The SQL for a field of the document, as the SQLite dialect writes it.
pub fn field_expr(f: &str) -> String {
    format!("json_extract(\"doc\", '$.{f}')")
}

/// The DDL that makes a table: documents are JSON in one column, so fields need no migration.
pub fn table_ddl(name: &str) -> String {
    format!("CREATE TABLE IF NOT EXISTS \"{name}\" (\"_id\" TEXT PRIMARY KEY, \"_creationTime\" REAL NOT NULL, \"doc\" TEXT NOT NULL)")
}

/// `ON "t" (expr, ..., "_creationTime", "_id")`: an index serves its fields, then the order key's tie-breakers.
pub fn index_body(table: &str, fields: &[String]) -> String {
    let cols: Vec<String> = fields.iter().map(|f| format!("({})", field_expr(f))).chain(["\"_creationTime\"".to_string(), "\"_id\"".to_string()]).collect();
    format!("ON \"{table}\" ({})", cols.join(", "))
}
