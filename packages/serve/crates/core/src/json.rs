//! A JSON reader for page data: values that borrow their strings from the input (no copy unless a string has an escape), objects as short lists.
//! A page's data is read once and looked at a few times, so what matters is how little it allocates; `serde_json::Value` made a map and a string per field.
use std::borrow::Cow;

#[derive(Debug, Clone, PartialEq)]
pub enum Val<'a> {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(Cow<'a, str>),
    Arr(Vec<Val<'a>>),
    Obj(Vec<(Cow<'a, str>, Val<'a>)>),
}

impl<'a> Val<'a> {
    pub fn get(&self, key: &str) -> Option<&Val<'a>> {
        match self {
            Val::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

struct P<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
}

pub fn parse(s: &str) -> Result<Val<'_>, String> {
    let mut p = P { s, b: s.as_bytes(), i: 0 };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("unexpected data after the JSON value at byte {}", p.i));
    }
    Ok(v)
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\n' | b'\r' | b'\t') {
            self.i += 1;
        }
    }

    fn err<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("invalid JSON: {what} at byte {}", self.i))
    }

    fn value(&mut self, depth: usize) -> Result<Val<'a>, String> {
        if depth > 128 {
            return self.err("nested too deeply");
        }
        self.ws();
        match self.b.get(self.i) {
            Some(b'{') => {
                self.i += 1;
                let mut fields = Vec::with_capacity(8);
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Val::Obj(fields));
                }
                loop {
                    self.ws();
                    if self.b.get(self.i) != Some(&b'"') {
                        return self.err("a key");
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return self.err("a colon");
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    fields.push((k, v));
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Val::Obj(fields));
                        }
                        _ => return self.err("a comma or a closing brace"),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::with_capacity(8);
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Val::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Val::Arr(items));
                        }
                        _ => return self.err("a comma or a closing bracket"),
                    }
                }
            }
            Some(b'"') => Ok(Val::Str(self.string()?)),
            Some(b't') if self.s[self.i..].starts_with("true") => {
                self.i += 4;
                Ok(Val::Bool(true))
            }
            Some(b'f') if self.s[self.i..].starts_with("false") => {
                self.i += 5;
                Ok(Val::Bool(false))
            }
            Some(b'n') if self.s[self.i..].starts_with("null") => {
                self.i += 4;
                Ok(Val::Null)
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.err("a value"),
        }
    }

    fn number(&mut self) -> Result<Val<'a>, String> {
        let start = self.i;
        let mut float = false;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        while let Some(c) = self.b.get(self.i) {
            match c {
                b'0'..=b'9' => {}
                b'.' | b'e' | b'E' | b'+' | b'-' => float = true,
                _ => break,
            }
            self.i += 1;
        }
        let t = &self.s[start..self.i];
        if !float {
            if let Ok(n) = t.parse::<i64>() {
                return Ok(Val::Int(n));
            }
        }
        t.parse::<f64>().map(Val::Num).or_else(|_| self.err("a number"))
    }

    fn string(&mut self) -> Result<Cow<'a, str>, String> {
        self.i += 1; // the opening quote
        let start = self.i;
        // The common case: no escape, so the text is borrowed from the input.
        while let Some(c) = self.b.get(self.i) {
            match c {
                b'"' => {
                    let t = &self.s[start..self.i];
                    self.i += 1;
                    return Ok(Cow::Borrowed(t));
                }
                b'\\' => break,
                c if *c < 0x20 => return self.err("a control character in a string"),
                _ => self.i += 1,
            }
        }
        let mut out = String::from(&self.s[start..self.i]);
        loop {
            match self.b.get(self.i) {
                None => return self.err("an unterminated string"),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(Cow::Owned(out));
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.b.get(self.i).ok_or("invalid JSON: a dangling escape")?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hex = |p: &mut P<'a>| -> Result<u32, String> {
                                let h = p.s.get(p.i..p.i + 4).ok_or("invalid JSON: a short \\u escape")?;
                                p.i += 4;
                                u32::from_str_radix(h, 16).map_err(|_| "invalid JSON: a bad \\u escape".to_string())
                            };
                            let mut cp = hex(self)?;
                            if (0xD800..0xDC00).contains(&cp) && self.s[self.i..].starts_with("\\u") {
                                self.i += 2;
                                let lo = hex(self)?;
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo.wrapping_sub(0xDC00) & 0x3FF);
                            }
                            out.push(char::from_u32(cp).unwrap_or('\u{FFFD}'));
                        }
                        _ => return self.err("an unknown escape"),
                    }
                }
                Some(_) => {
                    // copy a run of plain bytes at once
                    let from = self.i;
                    while self.i < self.b.len() && self.b[self.i] != b'"' && self.b[self.i] != b'\\' {
                        self.i += 1;
                    }
                    out.push_str(&self.s[from..self.i]);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_serde_reads() {
        let docs = [
            r#"{"a":1,"b":[true,false,null,"x\nyé😀"],"c":{"d":-0.5e2,"e":12345678901234}}"#,
            r#"[]"#,
            r#"{}"#,
            r#"  [1 , 2.5 ,"é" ]  "#,
            r#""a\"b\\c/d""#,
        ];
        for d in docs {
            let ours = parse(d).unwrap();
            let theirs: serde_json::Value = serde_json::from_str(d).unwrap();
            fn same(a: &Val, b: &serde_json::Value) -> bool {
                match (a, b) {
                    (Val::Null, serde_json::Value::Null) => true,
                    (Val::Bool(x), serde_json::Value::Bool(y)) => x == y,
                    (Val::Int(x), serde_json::Value::Number(y)) => y.as_i64() == Some(*x),
                    (Val::Num(x), serde_json::Value::Number(y)) => y.as_f64() == Some(*x),
                    (Val::Str(x), serde_json::Value::String(y)) => x == y,
                    (Val::Arr(x), serde_json::Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
                    (Val::Obj(x), serde_json::Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k.as_ref()).is_some_and(|w| same(v, w))),
                    _ => false,
                }
            }
            assert!(same(&ours, &theirs), "{d}");
        }
    }

    #[test]
    fn strings_without_escapes_are_borrowed() {
        let d = r#"["plain","esc\n"]"#;
        let Val::Arr(items) = parse(d).unwrap() else { panic!() };
        assert!(matches!(&items[0], Val::Str(Cow::Borrowed("plain"))));
        assert!(matches!(&items[1], Val::Str(Cow::Owned(_))));
    }

    #[test]
    fn rejects_what_is_not_json() {
        for bad in ["", "{", "[1,]", r#"{"a" 1}"#, "tru", "01x", r#""\q""#, "[1] 2", "\"a\u{1}\""] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert!(parse(&"[".repeat(500)).is_err());
    }
}
