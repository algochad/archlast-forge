//! The query planner: a description of a range of documents (the index, its equalities and bounds, where() predicates, the order, a limit, a keyset to start after)
//! to the SQL that reads it. The same statements the JavaScript DocStore wrote, so existing databases and their indexes serve them as before.

use crate::jsjson;
use crate::schema::{field_expr, safe_field, TableSpec};
use rusqlite::types::Value as Sql;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct Bound {
    pub op: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Deserialize)]
pub struct KeyDesc {
    pub f: String,
    pub desc: bool,
}

/// One related set to add to each result (JavaScript has resolved what the rule means, so this is the plan, not the rule): a document or documents this one points at
/// (`forward`: the `field` holds an id, or an array of ids when `many`), or the documents of `table` that point back through `index` (`reverse`), counted, or at most
/// `take` of them in index order (`orderDesc` reverses it), with their own `include`s.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Include {
    pub key: String,
    pub kind: String,
    pub field: String,
    #[serde(default)]
    pub many: bool,
    #[serde(default)]
    pub table: String,
    #[serde(default)]
    pub index: String,
    #[serde(default)]
    pub take: Option<u64>,
    #[serde(default)]
    pub order_desc: bool,
    #[serde(default)]
    pub count: bool,
    #[serde(default)]
    pub include: Vec<Include>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Desc {
    pub table: String,
    pub index: Option<String>,
    #[serde(default)]
    pub eqs: Vec<(String, Value)>,
    #[serde(default)]
    pub bounds: Vec<Bound>,
    #[serde(default)]
    pub bound_field: Option<String>,
    #[serde(default)]
    pub wheres: Vec<Value>,
    #[serde(default)]
    pub order_keys: Option<Vec<KeyDesc>>,
    #[serde(default)]
    pub desc: bool,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub skip: u64,
    #[serde(default)]
    pub after: Option<Vec<Value>>,
    /// select(): the fields each result keeps, besides _id and _creationTime.
    #[serde(default)]
    pub projection: Option<Vec<String>>,
    #[serde(default)]
    pub includes: Vec<Include>,
}

pub struct Plan {
    /// What the statement reads, as a reactivity topic: the equality prefix of the index, or the whole table.
    pub read: String,
    pub where_sql: String,
    pub params: Vec<Sql>,
    pub order_by: String,
}

struct Cond {
    sql: String,
    params: Vec<Sql>,
}

/// The `undefined` of a JavaScript value, which JSON cannot carry: the descriptor writes `{"$undefined":true}`.
fn undefined(v: &Value) -> bool {
    matches!(v, Value::Object(m) if m.len() == 1 && m.contains_key("$undefined"))
}

/// A value as the SQLite dialect binds it for a document field: booleans are 1 and 0, objects and arrays their JSON text.
pub fn encode(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(jsjson::stringify(other)),
    }
}

/// A value as it is bound for `_id` or `_creationTime`: as it is.
fn plain(v: &Value) -> Sql {
    match v {
        Value::Number(n) => n.as_i64().map(Sql::Integer).unwrap_or_else(|| Sql::Real(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => Sql::Text(s.clone()),
        Value::Null => Sql::Null,
        other => encode(other),
    }
}

fn builtin(f: &str) -> bool {
    f == "_id" || f == "_creationTime"
}

pub fn expr(f: &str) -> String {
    if builtin(f) { format!("\"{f}\"") } else { field_expr(f) }
}

fn bind(f: &str, v: &Value) -> Sql {
    if builtin(f) { plain(v) } else { encode(v) }
}

fn check(f: &str) -> Result<(), String> {
    if safe_field(f) { Ok(()) } else { Err(format!("{f:?} is not a field name")) }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A where() predicate, compiled: SQL with `?` placeholders and their values.
fn predicate(p: &Value) -> Result<Cond, String> {
    let t = str_of(p, "t");
    let null = Value::Null;
    let val = p.get("v").unwrap_or(&null);
    let f = str_of(p, "f");
    if matches!(t, "eq" | "neq" | "cmp" | "between" | "in" | "prefix") {
        check(f)?;
    }
    let e = expr(f);
    Ok(match t {
        "eq" => {
            if val.is_null() || undefined(val) {
                Cond { sql: format!("{e} IS NULL"), params: vec![] }
            } else if builtin(f) {
                Cond { sql: format!("\"{f}\" = ?"), params: vec![plain(val)] }
            } else {
                Cond { sql: format!("{e} = ?"), params: vec![encode(val)] }
            }
        }
        "neq" => {
            if val.is_null() || undefined(val) {
                Cond { sql: format!("{e} IS NOT NULL"), params: vec![] }
            } else {
                Cond { sql: format!("({e} IS NULL OR {e} <> ?)"), params: vec![bind(f, val)] }
            }
        }
        "cmp" => {
            let op = str_of(p, "op");
            if !matches!(op, ">" | ">=" | "<" | "<=") {
                return Err(format!("unknown operator {op:?}"));
            }
            Cond { sql: format!("{e} {op} ?"), params: vec![bind(f, val)] }
        }
        "between" => Cond { sql: format!("({e} >= ? AND {e} <= ?)"), params: vec![bind(f, p.get("lo").unwrap_or(&null)), bind(f, p.get("hi").unwrap_or(&null))] },
        "in" => {
            let vs = p.get("vs").and_then(Value::as_array).cloned().unwrap_or_default();
            if vs.is_empty() {
                Cond { sql: "1 = 0".into(), params: vec![] }
            } else {
                Cond { sql: format!("{e} IN ({})", vs.iter().map(|_| "?").collect::<Vec<_>>().join(", ")), params: vs.iter().map(|v| bind(f, v)).collect() }
            }
        }
        "prefix" => {
            let prefix = p.get("p").and_then(Value::as_str).unwrap_or("");
            Cond { sql: format!("({e} >= ? AND {e} < ?)"), params: vec![Sql::Text(prefix.to_string()), Sql::Text(format!("{prefix}\u{10FFFF}"))] }
        }
        "and" | "or" => {
            let glue = if t == "and" { "AND" } else { "OR" };
            let ps = p.get("ps").and_then(Value::as_array).cloned().unwrap_or_default();
            if ps.is_empty() {
                Cond { sql: if t == "and" { "1 = 1".into() } else { "1 = 0".into() }, params: vec![] }
            } else {
                let cs = ps.iter().map(predicate).collect::<Result<Vec<_>, _>>()?;
                Cond { sql: format!("({})", cs.iter().map(|c| c.sql.as_str()).collect::<Vec<_>>().join(&format!(" {glue} "))), params: cs.into_iter().flat_map(|c| c.params).collect() }
            }
        }
        "not" => {
            let inner = predicate(p.get("p").unwrap_or(&null))?;
            Cond { sql: format!("(CASE WHEN {} THEN 1 ELSE 0 END) = 0", inner.sql), params: inner.params }
        }
        other => return Err(format!("unknown predicate {other:?}")),
    })
}

pub struct Key {
    pub f: String,
    pub desc: bool,
}

/// The order key: orderBy()'s fields, or the index's after its equalities; then _creationTime and _id, which make it unique, in the direction of the last key
/// (so an index on those fields serves the whole order). A descending query reverses all of it.
pub fn order_key(d: &Desc, fields: &[String]) -> Vec<Key> {
    let base: Vec<Key> = match &d.order_keys {
        Some(ks) => ks.iter().map(|k| Key { f: k.f.clone(), desc: k.desc }).collect(),
        None => fields.iter().skip(d.eqs.len()).map(|f| Key { f: f.clone(), desc: false }).collect(),
    };
    let tie = base.last().map(|k| k.desc).unwrap_or(false);
    let mut keys: Vec<Key> = Vec::new();
    for k in base.into_iter().chain([Key { f: "_creationTime".into(), desc: tie }, Key { f: "_id".into(), desc: tie }]) {
        if !keys.iter().any(|x| x.f == k.f) {
            keys.push(k);
        }
    }
    if d.desc {
        keys.iter_mut().for_each(|k| k.desc = !k.desc);
    }
    keys
}

/// Rows after `after` in the order of `keys`: one row-value comparison when every key goes the same way (an index serves it), else (a > ?) OR (a = ? AND b < ?) ….
fn keyset(keys: &[Key], after: &[Value]) -> Cond {
    let enc = |i: usize| bind(&keys[i].f, after.get(i).unwrap_or(&Value::Null));
    if keys.iter().all(|k| k.desc == keys[0].desc) {
        let op = if keys[0].desc { "<" } else { ">" };
        return Cond {
            sql: format!("({}) {op} ({})", keys.iter().map(|k| expr(&k.f)).collect::<Vec<_>>().join(", "), keys.iter().map(|_| "?").collect::<Vec<_>>().join(", ")),
            params: (0..keys.len()).map(enc).collect(),
        };
    }
    let mut parts = Vec::new();
    let mut params = Vec::new();
    for (i, k) in keys.iter().enumerate() {
        let mut conds: Vec<String> = keys[..i].iter().map(|p| format!("{} = ?", expr(&p.f))).collect();
        conds.push(format!("{} {} ?", expr(&k.f), if k.desc { "<" } else { ">" }));
        parts.push(format!("({})", conds.join(" AND ")));
        params.extend((0..=i).map(enc));
    }
    Cond { sql: format!("({})", parts.join(" OR ")), params }
}

pub fn plan(table: &TableSpec, d: &Desc) -> Result<Plan, String> {
    let fields = table.index_fields(d.index.as_deref()).ok_or_else(|| format!("Unknown index \"{}.{}\"", d.table, d.index.as_deref().unwrap_or("")))?;
    let mut conds: Vec<Cond> = Vec::new();
    for (f, v) in &d.eqs {
        check(f)?;
        conds.push(if f == "_creationTime" {
            Cond { sql: "\"_creationTime\" = ?".into(), params: vec![plain(v)] }
        } else if undefined(v) {
            Cond { sql: format!("{} IS NULL", field_expr(f)), params: vec![] }
        } else {
            Cond { sql: format!("{} = ?", field_expr(f)), params: vec![encode(v)] }
        });
    }
    if let Some(bf) = &d.bound_field {
        check(bf)?;
        for b in &d.bounds {
            if !matches!(b.op.as_str(), ">" | ">=" | "<" | "<=") {
                return Err(format!("unknown operator {:?}", b.op));
            }
            conds.push(Cond { sql: format!("{} {} ?", expr(bf), b.op), params: vec![bind(bf, &b.value)] });
        }
    }
    for w in &d.wheres {
        conds.push(predicate(w)?);
    }
    let keys = order_key(d, &fields);
    for k in &keys {
        check(&k.f)?;
    }
    if let Some(after) = &d.after {
        conds.push(keyset(&keys, after));
    }
    let read = if !d.eqs.is_empty() && d.index.is_some() {
        let values: Vec<Value> = d.eqs.iter().map(|(_, v)| if undefined(v) { Value::Null } else { v.clone() }).collect();
        crate::topic(&d.table, d.index.as_deref().unwrap(), &values)
    } else {
        d.table.clone()
    };
    Ok(Plan {
        read,
        where_sql: if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.iter().map(|c| c.sql.as_str()).collect::<Vec<_>>().join(" AND ")) },
        params: conds.into_iter().flat_map(|c| c.params).collect(),
        order_by: keys.iter().map(|k| format!("{}{}", expr(&k.f), if k.desc { " DESC" } else { "" })).collect::<Vec<_>>().join(", "),
    })
}

/// The statement for up to `limit` documents of the range, past `skip` of them.
pub fn select_sql(d: &Desc, p: &Plan) -> String {
    // SQLite needs a LIMIT before an OFFSET.
    let page = if d.skip > 0 { format!(" LIMIT {} OFFSET {}", d.limit.map(|l| l.to_string()).unwrap_or_else(|| "9007199254740991".into()), d.skip) } else { d.limit.map(|l| format!(" LIMIT {l}")).unwrap_or_default() };
    format!("SELECT \"_id\", \"_creationTime\", \"doc\" FROM \"{}\" {} ORDER BY {}{}", d.table, p.where_sql, p.order_by, page)
}
