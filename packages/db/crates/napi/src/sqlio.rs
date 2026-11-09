//! Running statements and writing their rows as JSON text.

use rusqlite::{params_from_iter, types::Value as Sql, types::ValueRef, Connection};

pub fn push_string(out: &mut String, s: &str) {
    out.push('"');
    // nothing to escape (ids, names, most text): one copy
    if s.bytes().all(|b| b >= 0x20 && b != b'"' && b != b'\\') {
        out.push_str(s);
        out.push('"');
        return;
    }
    let mut start = 0;
    for (i, c) in s.char_indices() {
        let esc: Option<&str> = match c {
            '"' => Some("\\\""),
            '\\' => Some("\\\\"),
            '\n' => Some("\\n"),
            '\r' => Some("\\r"),
            '\t' => Some("\\t"),
            '\u{8}' => Some("\\b"),
            '\u{c}' => Some("\\f"),
            c if (c as u32) < 0x20 => None,
            _ => continue,
        };
        out.push_str(&s[start..i]);
        match esc {
            Some(e) => out.push_str(e),
            None => out.push_str(&format!("\\u{:04x}", c as u32)),
        }
        start = i + c.len_utf8();
    }
    out.push_str(&s[start..]);
    out.push('"');
}

pub fn push_value(out: &mut String, v: ValueRef<'_>) {
    match v {
        ValueRef::Null => out.push_str("null"),
        ValueRef::Integer(i) => {
            use std::fmt::Write;
            let _ = write!(out, "{i}");
        }
        ValueRef::Real(f) => crate::jsjson::push_number(out, f),
        ValueRef::Text(t) => push_string(out, &String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => {
            out.push('[');
            for (i, byte) in b.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&byte.to_string());
            }
            out.push(']');
        }
    }
}

/// Rows as JSON text: an array of objects keyed by column name.
pub fn rows_text(c: &Connection, sql: &str, params: Vec<Sql>) -> rusqlite::Result<String> {
    let mut stmt = c.prepare_cached(sql)?;
    let keys: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|n| {
            let mut k = String::new();
            push_string(&mut k, n);
            k.push(':');
            k
        })
        .collect();
    let mut rows = stmt.query(params_from_iter(params))?;
    let mut out = String::from("[");
    let mut first = true;
    while let Some(row) = rows.next()? {
        if !first {
            out.push(',');
        }
        first = false;
        out.push('{');
        for (i, key) in keys.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(key);
            push_value(&mut out, row.get_ref(i)?);
        }
        out.push('}');
    }
    out.push(']');
    Ok(out)
}

/// For a `SELECT "_id", "_creationTime", "doc"` statement: the documents as JSON text, an array of `{"_id":…,"_creationTime":…,<the fields of doc>}`.
/// The stored document is already JSON, so each one is joined to its id and time as text, never parsed.
pub fn docs_text(c: &Connection, sql: &str, params: Vec<Sql>) -> rusqlite::Result<String> {
    let mut stmt = c.prepare_cached(sql)?;
    let mut rows = stmt.query(params_from_iter(params))?;
    let mut out = String::from("[");
    let mut first = true;
    while let Some(row) = rows.next()? {
        if !first {
            out.push(',');
        }
        first = false;
        push_doc(&mut out, row.get_ref(0)?, row.get_ref(1)?, row.get_ref(2)?);
    }
    out.push(']');
    Ok(out)
}

pub fn push_doc(out: &mut String, id: ValueRef<'_>, time: ValueRef<'_>, doc: ValueRef<'_>) {
    out.push_str("{\"_id\":");
    match id {
        ValueRef::Text(t) => push_string(out, &String::from_utf8_lossy(t)),
        _ => out.push_str("null"),
    }
    out.push_str(",\"_creationTime\":");
    push_value(out, time);
    match doc {
        // `{"a":1}` becomes `,"a":1}`; `{}` becomes `}`
        ValueRef::Text(t) => {
            let doc = std::str::from_utf8(t).unwrap_or("{}").trim_start();
            let inner = doc.strip_prefix('{').unwrap_or("}");
            if inner.trim_start().starts_with('}') {
                out.push('}');
            } else {
                out.push(',');
                out.push_str(inner);
            }
        }
        _ => out.push('}'),
    }
}
