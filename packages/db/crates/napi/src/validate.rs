//! Checking a document against the schema's validators, which JavaScript hands over as data. This is a fast path that accepts and never rejects on its own: a value it
//! cannot vouch for (it fails a rule, or the rule needs a regular expression or a format) goes back to JavaScript, whose Zod schemas decide and word the error. So it is
//! never looser than Zod (it accepts only what Zod accepts) and, where it is stricter, JavaScript has the last word.

use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Checks {
    min: Option<f64>,
    max: Option<f64>,
    exclusive_min: Option<f64>,
    exclusive_max: Option<f64>,
    #[serde(default)]
    int: bool,
    min_length: Option<u64>,
    max_length: Option<u64>,
    pattern: Option<String>,
    format: Option<String>,
    min_items: Option<u64>,
    max_items: Option<u64>,
    #[serde(default)]
    unique: bool,
}

#[derive(Deserialize, Clone)]
pub struct Validator {
    pub kind: String,
    #[serde(default)]
    pub optional: bool,
    table: Option<String>,
    element: Option<Box<Validator>>,
    fields: Option<IndexMap<String, Validator>>,
    members: Option<Vec<Validator>>,
    value: Option<Value>,
    checks: Option<Checks>,
}

/// Whether `x` is surely valid for `v`.
pub fn accepts(v: &Validator, x: &Value) -> bool {
    let c = v.checks.as_ref();
    match v.kind.as_str() {
        "any" => true,
        "boolean" => x.is_boolean(),
        "null" => x.is_null(),
        "string" => match x {
            Value::String(s) => match c {
                None => true,
                Some(c) => {
                    if c.pattern.is_some() || c.format.is_some() {
                        return false;
                    }
                    let n = || s.chars().count() as u64;
                    c.min_length.map_or(true, |m| n() >= m) && c.max_length.map_or(true, |m| n() <= m)
                }
            },
            _ => false,
        },
        "number" => match x.as_f64() {
            Some(n) if x.is_number() && n.is_finite() => match c {
                None => true,
                Some(c) => {
                    (!c.int || n.fract() == 0.0)
                        && c.min.map_or(true, |m| n >= m)
                        && c.max.map_or(true, |m| n <= m)
                        && c.exclusive_min.map_or(true, |m| n > m)
                        && c.exclusive_max.map_or(true, |m| n < m)
                }
            },
            _ => false,
        },
        "literal" => match (&v.value, x) {
            (Some(Value::String(a)), Value::String(b)) => a == b,
            (Some(Value::Bool(a)), Value::Bool(b)) => a == b,
            (Some(Value::Number(a)), Value::Number(b)) => a.as_f64() == b.as_f64(),
            _ => false,
        },
        "id" => match (x.as_str(), &v.table) {
            (Some(s), Some(t)) => s.find(':').map_or(false, |i| &s[..i] == t),
            _ => false,
        },
        "array" => match (x, &v.element) {
            (Value::Array(a), Some(e)) => {
                if let Some(c) = c {
                    if c.min_items.map_or(false, |m| (a.len() as u64) < m) || c.max_items.map_or(false, |m| (a.len() as u64) > m) {
                        return false;
                    }
                    if c.unique {
                        let mut seen = std::collections::HashSet::new();
                        if !a.iter().all(|i| seen.insert(crate::jsjson::stringify(i))) {
                            return false;
                        }
                    }
                }
                a.iter().all(|i| accepts(e, i))
            }
            _ => false,
        },
        "object" => match (x, &v.fields) {
            (Value::Object(m), Some(fields)) => object_accepts(fields, m),
            _ => false,
        },
        "union" => v.members.as_ref().map_or(false, |ms| ms.iter().any(|m| accepts(m, x))),
        _ => false,
    }
}

/// A strict object: every key is a field, and every field that is not optional is there. (A field that is optional may be absent; a present one must be valid.)
pub fn object_accepts(fields: &IndexMap<String, Validator>, m: &serde_json::Map<String, Value>) -> bool {
    m.iter().all(|(k, x)| fields.get(k).map_or(false, |f| accepts(f, x))) && fields.iter().all(|(k, f)| f.optional || m.contains_key(k))
}
