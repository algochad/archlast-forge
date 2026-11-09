//! A scanner for the JSON text the engine writes: it finds the elements of an array and the members of an object without parsing their values, so a projection or a page
//! is cut out of the text. The text is trusted to be valid JSON (it was written by `JSON.stringify` or by this crate); on anything unexpected the functions answer None.

/// The index after the value that starts at `i` (whitespace before it skipped by the caller).
fn skip_value(b: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 0usize;
    loop {
        match *b.get(i)? {
            b'"' => {
                i += 1;
                loop {
                    match *b.get(i)? {
                        b'\\' => i += 2,
                        b'"' => break,
                        _ => i += 1,
                    }
                }
                i += 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                if depth == 0 {
                    return Some(i); // the end of the enclosing value, not part of this one (a number or literal just before it)
                }
                depth -= 1;
                i += 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b',' | b':' if depth == 0 => return Some(i),
            c if depth == 0 && !c.is_ascii_whitespace() => {
                // a number, true, false or null: up to the next delimiter
                while let Some(&c) = b.get(i) {
                    if matches!(c, b',' | b'}' | b']' | b':') || c.is_ascii_whitespace() {
                        break;
                    }
                    i += 1;
                }
                return Some(i);
            }
            _ => i += 1,
        }
    }
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while b.get(i).is_some_and(|c| c.is_ascii_whitespace()) {
        i += 1;
    }
    i
}

/// The texts of the elements of the array `text` (`[a,b]`).
pub fn elements(text: &str) -> Option<Vec<&str>> {
    let b = text.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'[') {
        return None;
    }
    i = skip_ws(b, i + 1);
    let mut out = Vec::new();
    if b.get(i) == Some(&b']') {
        return Some(out);
    }
    loop {
        let end = skip_value(b, i)?;
        out.push(&text[i..end]);
        i = skip_ws(b, end);
        match b.get(i)? {
            b',' => i = skip_ws(b, i + 1),
            b']' => return Some(out),
            _ => return None,
        }
    }
}

/// Calls `f` with each member of the object `text`: its key as written between the quotes, and its value text.
pub fn each_member<'a>(text: &'a str, mut f: impl FnMut(&'a str, &'a str)) -> Option<()> {
    let b = text.as_bytes();
    let mut i = skip_ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return None;
    }
    i = skip_ws(b, i + 1);
    if b.get(i) == Some(&b'}') {
        return Some(());
    }
    loop {
        if b.get(i) != Some(&b'"') {
            return None;
        }
        let key_end = skip_value(b, i)?;
        let key = &text[i + 1..key_end - 1];
        i = skip_ws(b, key_end);
        if b.get(i) != Some(&b':') {
            return None;
        }
        i = skip_ws(b, i + 1);
        let end = skip_value(b, i)?;
        f(key, &text[i..end]);
        i = skip_ws(b, end);
        match b.get(i)? {
            b',' => i = skip_ws(b, i + 1),
            b'}' => return Some(()),
            _ => return None,
        }
    }
}

/// The members of the object `text` as (key as written between its quotes, value text).
pub fn members(text: &str) -> Option<Vec<(&str, &str)>> {
    let mut out = Vec::new();
    each_member(text, |k, v| out.push((k, v)))?;
    Some(out)
}

/// The documents of `array` with only `_id`, `_creationTime` and the `keep` fields, in that order (a field a document lacks is left out), as an array text.
pub fn project(array: &str, keep: &[String]) -> Option<String> {
    let mut names: Vec<&str> = Vec::with_capacity(keep.len() + 2);
    for name in ["_id", "_creationTime"].into_iter().chain(keep.iter().map(String::as_str)) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let docs = elements(array)?;
    let mut out = String::with_capacity(array.len() / 2 + 8);
    out.push('[');
    let mut slots: Vec<Option<&str>> = vec![None; names.len()];
    for (n, doc) in docs.iter().enumerate() {
        if n > 0 {
            out.push(',');
        }
        slots.iter_mut().for_each(|s| *s = None);
        each_member(doc, |k, v| {
            if let Some(at) = names.iter().position(|name| *name == k) {
                slots[at] = Some(v);
            }
        })?;
        out.push('{');
        let mut first = true;
        for (name, value) in names.iter().zip(&slots) {
            if let Some(v) = value {
                if !first {
                    out.push(',');
                }
                first = false;
                out.push('"');
                out.push_str(name);
                out.push_str("\":");
                out.push_str(v);
            }
        }
        out.push('}');
    }
    out.push(']');
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn splits_and_projects_like_serde() {
        let docs = json!([
            {"_id":"a:1","_creationTime":1.5,"name":"x \"q\" , } ]","n":[1,{"k":"v,}"}],"o":{"p":null},"t":true,"z":-0.5e-7},
            {"_id":"a:2","_creationTime":2,"name":"é漢😀\\\\","n":[],"o":{}},
            {"_id":"a:3","_creationTime":3}
        ]);
        let text = serde_json::to_string(&docs).unwrap();
        let parts = elements(&text).unwrap();
        assert_eq!(parts.len(), 3);
        for (p, d) in parts.iter().zip(docs.as_array().unwrap()) {
            assert_eq!(&serde_json::from_str::<Value>(p).unwrap(), d);
            let m = members(p).unwrap();
            assert_eq!(m.len(), d.as_object().unwrap().len());
        }
        let keep = vec!["name".to_string(), "missing".to_string(), "o".to_string(), "name".to_string()];
        let got: Value = serde_json::from_str(&project(&text, &keep).unwrap()).unwrap();
        let want: Vec<Value> = docs
            .as_array()
            .unwrap()
            .iter()
            .map(|d| {
                let mut o = serde_json::Map::new();
                for f in ["_id", "_creationTime", "name", "missing", "o"] {
                    if let Some(x) = d.get(f) {
                        o.insert(f.into(), x.clone());
                    }
                }
                Value::Object(o)
            })
            .collect();
        assert_eq!(got, Value::Array(want));
        assert_eq!(elements("[]").unwrap().len(), 0);
        assert_eq!(project("[]", &keep).unwrap(), "[]");
        assert!(elements("{}").is_none());
    }
}
