//! The terminals that do more than read a range: related documents (`include`), pages with a cursor, sums and other aggregates, and search. Each is one call from
//! JavaScript; the sub-reads they make go through the same cache and the same topics as any other read.

use super::*;
use crate::jsonscan;

fn unreadable() -> E {
    E::Other("unreadable documents".into())
}
use crate::plan::{self, Include};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

const MAX_SCAN: u64 = 100_000;
const OR_CHUNK: usize = 100;

fn str_of(v: &Value) -> Option<&str> {
    v.as_str()
}

/// `typeof` for a value read from JSON, as JavaScript says it.
fn type_of(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "string",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        _ => "object",
    }
}

fn parse_docs(text: &str) -> R<Vec<Value>> {
    serde_json::from_str(text).map_err(|e| E::Other(e.to_string()))
}

fn put(doc: &mut Value, key: &str, value: Value) {
    if let Value::Object(m) = doc {
        m.insert(key.to_string(), value);
    }
}

impl Engine {
    /// Runs a raw statement on the transaction's connection (after its lazy BEGIN), for a read that is not cached.
    fn with_conn<T>(&mut self, id: usize, f: impl FnOnce(&Connection) -> R<T>) -> R<T> {
        let tx = Self::tx_mut(&mut self.txs, id)?;
        let c = match tx.kind {
            Kind::Read(r) => &self.readers[r],
            Kind::Write => &self.writer,
        };
        Self::begin_if_needed(c, tx)?;
        f(c)
    }

    /// The documents of a range, parsed, for the terminals that go on to do something with them.
    fn range_values(&mut self, tx: usize, table: &str, key: String, d: &Desc) -> R<Vec<Value>> {
        let text = self.query_key(tx, table, key, d)?;
        parse_docs(&text)
    }

    /// Documents by id as values (None where one isn't there).
    fn many_values(&mut self, tx: usize, ids: &[String]) -> R<Vec<Option<Value>>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let text = self.get_many(tx, ids)?;
        Ok(parse_docs(&text)?.into_iter().map(|v| if v.is_null() { None } else { Some(v) }).collect())
    }

    // ---- related documents ----

    /// Adds the related documents each rule describes to each of `docs` (which belong to `table`), in as few reads as it can.
    pub fn include_all(&mut self, tx: usize, table: &str, docs: &mut [Value], rules: &[Include]) -> R<()> {
        if docs.is_empty() {
            return Ok(());
        }
        for rule in rules {
            if rule.kind == "forward" {
                let mut ids: Vec<String> = Vec::new();
                let mut seen: HashSet<String> = HashSet::new();
                for d in docs.iter() {
                    match d.get(&rule.field) {
                        Some(Value::Array(a)) if rule.many => {
                            for x in a {
                                if let Some(s) = str_of(x) {
                                    if !s.is_empty() && seen.insert(s.to_string()) {
                                        ids.push(s.to_string());
                                    }
                                }
                            }
                        }
                        Some(Value::String(s)) if !rule.many && !s.is_empty() => {
                            if seen.insert(s.clone()) {
                                ids.push(s.clone());
                            }
                        }
                        _ => {}
                    }
                }
                let found: HashMap<String, Value> = ids.iter().cloned().zip(self.many_values(tx, &ids)?).filter_map(|(id, v)| v.map(|v| (id, v))).collect();
                for d in docs.iter_mut() {
                    let value = if rule.many {
                        let items: Vec<Value> = d.get(&rule.field).and_then(Value::as_array).map(|a| a.iter().filter_map(str_of).filter_map(|id| found.get(id).cloned()).collect()).unwrap_or_default();
                        Value::Array(items)
                    } else {
                        d.get(&rule.field).and_then(str_of).and_then(|id| found.get(id).cloned()).unwrap_or(Value::Null)
                    };
                    put(d, &rule.key, value);
                }
            } else {
                self.include_reverse(tx, table, docs, rule)?;
            }
        }
        Ok(())
    }

    fn include_reverse(&mut self, tx: usize, _table: &str, docs: &mut [Value], rule: &Include) -> R<()> {
        let child = self.table(&rule.table)?.clone_index_fields(&rule.index);
        let field = &rule.field;
        let parents: Vec<String> = {
            let mut seen = HashSet::new();
            docs.iter().filter_map(|d| d.get("_id").and_then(str_of)).filter(|id| seen.insert(id.to_string())).map(String::from).collect()
        };
        if rule.count {
            let mut counts: HashMap<String, f64> = HashMap::new();
            for id in &parents {
                let read = topic(&rule.table, &rule.index, &[Value::String(id.clone())]);
                let sql = format!("SELECT COUNT(*) AS \"n\" FROM \"{}\" WHERE {} = ?1", rule.table, crate::schema::field_expr(field));
                let key = format!("K\0{}\0{}\0{}", rule.table, field, id);
                let text = self.cached(tx, &rule.table, key, |c| Ok((rows_text(c, &sql, vec![Sql::Text(id.clone())])?, vec![read])))?;
                let rows = parse_docs(&text)?;
                counts.insert(id.clone(), rows.first().and_then(|r| r.get("n")).and_then(Value::as_f64).unwrap_or(0.0));
            }
            for d in docs.iter_mut() {
                let n = d.get("_id").and_then(str_of).and_then(|id| counts.get(id)).copied().unwrap_or(0.0);
                put(d, &rule.key, Value::from(n as i64));
            }
            return Ok(());
        }
        // The index's order after the equality, then _creationTime and _id; descending flips all of it.
        let mut rest: Vec<String> = child.iter().skip(1).filter(|f| *f != "_creationTime").cloned().collect();
        rest.push("_creationTime".into());
        rest.push("_id".into());
        let order_by = rest.iter().map(|f| format!("{}{}", plan::expr(f), if rule.order_desc { " DESC" } else { "" })).collect::<Vec<_>>().join(", ");
        let select = format!("SELECT \"_id\", \"_creationTime\", \"doc\" FROM \"{}\"", rule.table);
        if let Some(take) = rule.take {
            // A limit per parent needs a statement per parent.
            for d in docs.iter_mut() {
                let id = d.get("_id").and_then(str_of).unwrap_or("").to_string();
                let read = topic(&rule.table, &rule.index, &[Value::String(id.clone())]);
                let mut kids: Vec<Value> = if take == 0 {
                    let tx_ref = Self::tx_mut(&mut self.txs, tx)?;
                    Self::read_topic(tx_ref, &read);
                    vec![]
                } else {
                    let sql = format!("{select} WHERE {} = ?1 ORDER BY {order_by} LIMIT {take}", crate::schema::field_expr(field));
                    let key = format!("P\0{}\0{}\0{}\0{}\0{}", rule.table, field, id, take, order_by);
                    let text = self.cached(tx, &rule.table, key, |c| Ok((docs_text(c, &sql, vec![Sql::Text(id.clone())])?, vec![read])))?;
                    parse_docs(&text)?
                };
                if !rule.include.is_empty() {
                    self.include_all(tx, &rule.table, &mut kids, &rule.include)?;
                }
                put(d, &rule.key, Value::Array(kids));
            }
            return Ok(());
        }
        // Everything at once: one statement for a chunk of parents, grouped afterwards.
        let mut groups: HashMap<String, Vec<Value>> = parents.iter().map(|id| (id.clone(), vec![])).collect();
        for chunk in parents.chunks(OR_CHUNK) {
            let topics: Vec<String> = chunk.iter().map(|id| topic(&rule.table, &rule.index, &[Value::String(id.clone())])).collect();
            let conds = chunk.iter().map(|_| format!("{} = ?", crate::schema::field_expr(field))).collect::<Vec<_>>().join(" OR ");
            let sql = format!("{select} WHERE ({conds}) ORDER BY {order_by}");
            let key = format!("R\0{}\0{}\0{}\0{}", rule.table, field, order_by, chunk.join("\0"));
            let params: Vec<Sql> = chunk.iter().map(|id| Sql::Text(id.clone())).collect();
            let text = self.cached(tx, &rule.table, key, |c| Ok((docs_text(c, &sql, params)?, topics)))?;
            for kid in parse_docs(&text)? {
                if let Some(g) = kid.get(field.as_str()).and_then(str_of).and_then(|p| groups.get_mut(p)) {
                    g.push(kid);
                }
            }
        }
        if !rule.include.is_empty() {
            let mut all: Vec<Value> = groups.values().flatten().cloned().collect();
            self.include_all(tx, &rule.table, &mut all, &rule.include)?;
            let joined: HashMap<String, Value> = all.into_iter().filter_map(|c| c.get("_id").and_then(str_of).map(String::from).map(|id| (id, c))).collect();
            for g in groups.values_mut() {
                for c in g.iter_mut() {
                    if let Some(j) = c.get("_id").and_then(str_of).and_then(|id| joined.get(id)) {
                        *c = j.clone();
                    }
                }
            }
        }
        for d in docs.iter_mut() {
            let kids = d.get("_id").and_then(str_of).and_then(|id| groups.get(id)).cloned().unwrap_or_default();
            put(d, &rule.key, Value::Array(kids));
        }
        Ok(())
    }

    /// `select()`: each result keeps _id, _creationTime and the fields asked for (a field it doesn't have stays out).
    fn project(docs: Vec<Value>, keep: &[String]) -> Vec<Value> {
        docs.into_iter()
            .map(|d| {
                let mut out = serde_json::Map::new();
                for f in ["_id", "_creationTime"] {
                    if let Some(x) = d.get(f) {
                        out.insert(f.into(), x.clone());
                    }
                }
                for f in keep {
                    if let Some(x) = d.get(f) {
                        out.insert(f.clone(), x.clone());
                    }
                }
                Value::Object(out)
            })
            .collect()
    }

    /// What a query returns once its related documents are added and its fields chosen: JSON text.
    fn finish(&mut self, tx: usize, table: &str, mut docs: Vec<Value>, d: &Desc) -> R<String> {
        if !d.includes.is_empty() {
            self.include_all(tx, table, &mut docs, &d.includes)?;
        }
        if let Some(keep) = &d.projection {
            docs = Self::project(docs, keep);
        }
        Ok(jsjson::stringify(&Value::Array(docs)))
    }

    /// A range with related documents and a choice of fields, as JSON text.
    pub fn query_full(&mut self, tx: usize, table: &str, desc: &str) -> R<String> {
        self.table(table)?;
        let p = self.planned(desc)?;
        if p.plain {
            // no related documents to add: the documents are cut out of the text as they came, never parsed; the answer is found by the description's text
            let result = self.cached(tx, table, format!("F\0{desc}"), |c| {
                let text = docs_text(c, &p.sql, p.params.clone())?;
                let out = match &p.projection {
                    None => text,
                    Some(keep) => jsonscan::project(&text, keep).ok_or_else(unreadable)?,
                };
                Ok((out, vec![p.read.clone()]))
            })?;
            return Ok(result.to_string());
        }
        let d: Desc = serde_json::from_str(desc).map_err(|e| E::Other(e.to_string()))?;
        let docs = self.range_values(tx, table, format!("Q\0{desc}"), &d)?;
        self.finish(tx, table, docs, &d)
    }
    /// Related documents added to documents JavaScript has (a JSON array), by the rules JavaScript made of an `include()` (a JSON array).
    pub fn join(&mut self, tx: usize, table: &str, docs: &str, rules: &str) -> R<String> {
        let mut docs = parse_docs(docs)?;
        let rules: Vec<Include> = serde_json::from_str(rules).map_err(|e| E::Other(e.to_string()))?;
        self.include_all(tx, table, &mut docs, &rules)?;
        Ok(jsjson::stringify(&Value::Array(docs)))
    }
    pub fn paginate(&mut self, tx: usize, table: &str, desc: &str, num_items: u64, cursor: Option<&str>, extra: u64, with_total: bool) -> R<String> {
        let mut d: Desc = serde_json::from_str(desc).map_err(|e| E::Other(e.to_string()))?;
        let spec = self.table(table)?.clone_fields(d.index.as_deref()).ok_or_else(|| v(format!("Unknown index \"{table}.{}\"", d.index.as_deref().unwrap_or(""))))?;
        let keys = plan::order_key(&d, &spec);
        let key_fields: Vec<String> = keys.iter().map(|k| k.f.clone()).collect();
        let after: Option<Vec<Value>> = match cursor {
            None => None,
            Some(c) => {
                let bytes = URL_SAFE_NO_PAD.decode(c).map_err(|_| v("Invalid pagination cursor (was the query or index changed?)"))?;
                let values: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| v("Invalid pagination cursor (was the query or index changed?)"))?;
                if values.len() != key_fields.len() {
                    return Err(v("Invalid pagination cursor (was the query or index changed?)"));
                }
                Some(values)
            }
        };
        // skip() places the first page; a cursor already says where the next one starts. An offset counts from wherever the page starts.
        let skip = (if after.is_some() { 0 } else { d.skip }) + extra;
        if skip > MAX_SCAN {
            return Err(v(format!("paginate() passes over at most {MAX_SCAN} documents, got {skip}; go further with a cursor")));
        }
        let total_desc = if with_total { Some(desc.to_string()) } else { None };
        d.limit = Some(num_items + 1);
        d.skip = skip;
        d.after = after;
        let cursor_part = cursor.unwrap_or("");
        let key = format!("Q\0{desc}\0P{num_items}\0{skip}\0{cursor_part}");
        let (page_text, done, continue_cursor) = if d.includes.is_empty() {
            // the page is cut out of the text the range came as: only the last document is read, for the cursor
            let text = self.query_key(tx, table, key, &d)?;
            let parts = jsonscan::elements(&text).ok_or_else(unreadable)?;
            let n = num_items as usize;
            let done = parts.len() <= n;
            let page = &parts[..parts.len().min(n)];
            let continue_cursor = match page.last() {
                Some(last) => {
                    let m = jsonscan::members(last).ok_or_else(unreadable)?;
                    let mut keys = String::from("[");
                    for (i, f) in key_fields.iter().enumerate() {
                        if i > 0 {
                            keys.push(',');
                        }
                        match m.iter().find(|(k, _)| k == f) {
                            Some((_, x)) if *x != "null" => keys.push_str(x),
                            _ => keys.push_str("null"),
                        }
                    }
                    keys.push(']');
                    URL_SAFE_NO_PAD.encode(keys)
                }
                None => cursor.map(String::from).unwrap_or_else(|| URL_SAFE_NO_PAD.encode("[]")),
            };
            let mut array = String::with_capacity(text.len());
            array.push('[');
            array.push_str(&page.join(","));
            array.push(']');
            let page_text = match &d.projection {
                None => array,
                Some(keep) => jsonscan::project(&array, keep).ok_or_else(unreadable)?,
            };
            (page_text, done, continue_cursor)
        } else {
            let mut docs = self.range_values(tx, table, key, &d)?;
            let done = docs.len() as u64 <= num_items;
            docs.truncate(num_items as usize);
            let encode = |vals: Vec<Value>| URL_SAFE_NO_PAD.encode(jsjson::stringify(&Value::Array(vals)));
            let continue_cursor = match docs.last() {
                Some(last) => encode(key_fields.iter().map(|f| match last.get(f) { None | Some(Value::Null) => Value::Null, Some(x) => x.clone() }).collect()),
                None => cursor.map(String::from).unwrap_or_else(|| encode(vec![])),
            };
            (self.finish(tx, table, docs, &d)?, done, continue_cursor)
        };
        let mut out = format!("{{\"page\":{page_text},\"isDone\":{done},\"continueCursor\":{}", serde_json::to_string(&continue_cursor).unwrap());
        if let Some(td) = total_desc {
            out.push_str(&format!(",\"total\":{}", jsjson::number(self.count(tx, table, &td)?)));
        }
        out.push('}');
        Ok(out)
    }

    // ---- aggregates ----

    /// `sum`, `avg`, `min` or `max` of a number field over a range, as JSON text (`null` where there is no value). The database works it out when the answer is exactly
    /// the one a pass over the documents would give; otherwise the documents are read (which also words the error for a field that holds something else).
    pub fn aggregate(&mut self, tx: usize, table: &str, desc: &str, kind: &str, field: &str) -> R<String> {
        if !crate::schema::safe_field(field) {
            return Err(v(format!("{field:?} is not a field name")));
        }
        let d: Desc = serde_json::from_str(desc).map_err(|e| E::Other(e.to_string()))?;
        let spec = self.table(table)?.clone_fields(d.index.as_deref()).ok_or_else(|| v(format!("Unknown index \"{table}.{}\"", d.index.as_deref().unwrap_or(""))))?;
        let _ = spec;
        let stats = if d.skip == 0 && field != "_creationTime" && field != "_id" { self.number_stats(tx, table, desc, field)? } else { None };
        match (kind, &stats) {
            ("sum", Some(s)) if s.sum.is_some() => return Ok(jsjson::number(s.sum.unwrap())),
            ("avg", Some(s)) if s.sum.is_some() => return Ok(if s.n > 0.0 { jsjson::number(s.sum.unwrap() / s.n) } else { "null".into() }),
            ("min", Some(s)) => return Ok(s.min.map(jsjson::number).unwrap_or_else(|| "null".into())),
            ("max", Some(s)) => return Ok(s.max.map(jsjson::number).unwrap_or_else(|| "null".into())),
            _ => {}
        }
        // a pass over the documents
        let mut scan = serde_json::from_str::<Desc>(desc).map_err(|e| E::Other(e.to_string()))?;
        scan.limit = Some(MAX_SCAN + 1);
        let key = format!("Q\0{desc}\0SCAN");
        let docs = self.range_values(tx, table, key, &scan)?;
        if docs.len() as u64 > MAX_SCAN {
            return Err(v(format!("Aggregates scan at most {MAX_SCAN} documents of \"{table}\"; narrow the range with withIndex()")));
        }
        let mut values: Vec<f64> = Vec::new();
        for d in &docs {
            match d.get(field) {
                None | Some(Value::Null) => {}
                Some(Value::Number(n)) => values.push(n.as_f64().unwrap_or(f64::NAN)),
                Some(x) => return Err(v(format!("{kind}(): \"{table}.{field}\" holds a {}, not a number", type_of(x)))),
            }
        }
        let n = values.len() as f64;
        Ok(match kind {
            "sum" => jsjson::number(values.iter().sum()),
            "avg" => if values.is_empty() { "null".into() } else { jsjson::number(values.iter().sum::<f64>() / n) },
            "min" => values.iter().copied().reduce(f64::min).map(jsjson::number).unwrap_or_else(|| "null".into()),
            _ => values.iter().copied().reduce(f64::max).map(jsjson::number).unwrap_or_else(|| "null".into()),
        })
    }

    /// Counts and extremes of a number field in a range, worked out by SQLite; None when the database can't tell exactly (the caller reads the documents).
    fn number_stats(&mut self, tx: usize, table: &str, desc: &str, field: &str) -> R<Option<Stats>> {
        let d: Desc = serde_json::from_str(desc).map_err(|e| E::Other(e.to_string()))?;
        let t = self.table(table)?;
        let p = plan::plan(t, &d).map_err(v)?;
        let path = format!("'$.{field}'");
        let val = format!("json_extract(\"doc\", {path})");
        let sql = format!("SELECT COUNT(*) AS \"rows\", COUNT({val}) AS \"n\", SUM(typeof({val}) NOT IN ('integer', 'null')) AS \"nonint\", SUM(typeof({val}) NOT IN ('integer', 'real', 'null')) AS \"bad\", SUM({val} IN (0, 1)) AS \"amb\", TOTAL({val}) AS \"sum\", MIN({val}) AS \"min\", MAX({val}) AS \"max\" FROM \"{table}\" {}", p.where_sql);
        let (read, params) = (p.read.clone(), p.params);
        let params2: Vec<Sql> = params.clone();
        let key = format!("N\0{desc}\0{field}");
        let text = self.cached(tx, table, key, |c| Ok((rows_text(c, &sql, params)?, vec![read.clone()])))?;
        let row = match parse_docs(&text)?.into_iter().next() {
            Some(r) => r,
            None => return Ok(None),
        };
        let num = |k: &str| row.get(k).and_then(Value::as_f64);
        let mut bad = num("bad").unwrap_or(0.0);
        if bad == 0.0 && num("amb").unwrap_or(0.0) > 0.0 {
            let t2 = self.table(table)?;
            let p2 = plan::plan(t2, &d).map_err(v)?;
            let cond = if p2.where_sql.is_empty() { "WHERE".to_string() } else { format!("{} AND", p2.where_sql) };
            let sql2 = format!("SELECT SUM(json_type(\"doc\", {path}) NOT IN ('integer', 'real', 'null')) AS \"bad\" FROM \"{table}\" {cond} {val} IN (0, 1)");
            let key2 = format!("N2\0{desc}\0{field}");
            let text2 = self.cached(tx, table, key2, |c| Ok((rows_text(c, &sql2, params2)?, vec![read])))?;
            bad = parse_docs(&text2)?.first().and_then(|r| r.get("bad")).and_then(Value::as_f64).unwrap_or(0.0);
        }
        let rows = num("rows").unwrap_or(0.0);
        if rows >= MAX_SCAN as f64 || bad > 0.0 {
            return Ok(None);
        }
        let n = num("n").unwrap_or(0.0);
        let (min, max) = (num("min"), num("max"));
        let nonint = num("nonint").unwrap_or(0.0);
        let exact = nonint == 0.0 && (n == 0.0 || n * min.unwrap_or(0.0).abs().max(max.unwrap_or(0.0).abs()) <= 9007199254740991.0);
        Ok(Some(Stats { n, sum: if exact { num("sum") } else { None }, min, max }))
    }

    // ---- search ----

    /// Documents whose search field has every one of `terms` (lowercase words, the last as a prefix), best match first, as JSON text. `spec` is JSON:
    /// { table, index, terms, filters: [[field, value]], limit, includes?, projection? }.
    pub fn search(&mut self, tx: usize, spec: &str) -> R<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct S {
            table: String,
            index: String,
            terms: Vec<String>,
            #[serde(default)]
            filters: Vec<(String, Value)>,
            limit: u64,
            #[serde(default)]
            includes: Vec<Include>,
            #[serde(default)]
            projection: Option<Vec<String>>,
        }
        let s: S = serde_json::from_str(spec).map_err(|e| E::Other(e.to_string()))?;
        let t = self.table(&s.table)?;
        let fts = t.search.iter().find(|(n, _)| n == &s.index).map(|(_, c)| c.fts.clone()).ok_or_else(|| v(format!("Unknown search index \"{}.{}\"", s.table, s.index)))?;
        let read_table = s.table.clone();
        {
            let tx_ref = Self::tx_mut(&mut self.txs, tx)?;
            Self::read_topic(tx_ref, &read_table); // any write to the table may change ranking
        }
        if s.terms.is_empty() {
            return Ok("[]".into());
        }
        let last = s.terms.len() - 1;
        let matched = s.terms.iter().enumerate().map(|(i, t)| format!("\"{t}\"{}", if i == last { "*" } else { "" })).collect::<Vec<_>>().join(" ");
        let mut params: Vec<Sql> = vec![Sql::Text(matched)];
        let mut conds = String::new();
        for (f, value) in &s.filters {
            if !crate::schema::safe_field(f) {
                return Err(v(format!("{f:?} is not a field name")));
            }
            let e = crate::schema::field_expr(f);
            if value.is_null() || value.get("$undefined").is_some() {
                conds.push_str(&format!(" AND {e} IS NULL"));
            } else {
                conds.push_str(&format!(" AND {e} = ?"));
                params.push(plan::encode(value));
            }
        }
        let tn = &s.table;
        let sql = format!("SELECT \"{tn}\".\"_id\", \"{tn}\".\"_creationTime\", \"{tn}\".\"doc\" FROM \"{fts}\" JOIN \"{tn}\" ON \"{tn}\".\"_id\" = \"{fts}\".doc_id WHERE \"{fts}\" MATCH ?{conds} ORDER BY \"{fts}\".rank LIMIT {}", s.limit.min(1024));
        let text = self.with_conn(tx, |c| Ok(docs_text(c, &sql, params)?))?;
        let docs = parse_docs(&text)?;
        let d = Desc { table: s.table.clone(), index: None, eqs: vec![], bounds: vec![], bound_field: None, wheres: vec![], order_keys: None, desc: false, limit: None, skip: 0, after: None, projection: s.projection, includes: s.includes };
        self.finish(tx, &s.table, docs, &d)
    }
}

struct Stats {
    n: f64,
    sum: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
}
