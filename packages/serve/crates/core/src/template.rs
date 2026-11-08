//! Page templates: HTML with holes, filled from JSON data, in Rust.
//!
//! A template is made at build time from a component (see packages/framework/src/render-compile.ts) and is a list of nodes; the expressions in it are the small
//! part of JavaScript that components use to print data: paths, `&&`, `||`, `??`, `?:`, `===`, `!`, `+`, template literals and `.length`. They follow JavaScript's
//! rules (truthiness, string conversion), and the output is escaped the way React escapes it, so a page printed here is the page React would print.
//!
//! Nodes (JSON): `"text"` is HTML as it is; `["x", e]` prints `e` as escaped text (nothing for null, undefined and booleans, as React does);
//! `["a", name, e, boolean]` prints an attribute (omitted for null/undefined/false; `true` is `name=""` for a boolean attribute, else omitted);
//! `["if", e, then, else]`; `["map", e, item, index, body]`; `["style", e]` is not here: styles are made at build time.
//! Expressions: `["l", value]`, `["p", "var", "key", ...]` (a variable and keys into it; a number key indexes an array), `["!", e]`, `["&&", a, b]`, `["||", a, b]`,
//! `["??", a, b]`, `["?:", c, a, b]`, `["===", a, b]`, `["!==", a, b]`, `["+", a, b]`, `["`", [e, ...]]`.
use crate::json::{self, Val};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug)]
enum Expr {
    Lit(Val<'static>),
    Path(String, Vec<Key>),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Nullish(Box<Expr>, Box<Expr>),
    Cond(Box<Expr>, Box<Expr>, Box<Expr>),
    Eq(Box<Expr>, Box<Expr>, bool),
    Add(Box<Expr>, Box<Expr>),
    /// Numbers (and, for the relational ones, strings): `< > <= >= - * / %`.
    Bin(Op, Box<Expr>, Box<Expr>),
    Concat(Vec<Expr>),
    /// A navigation link's active state: the request path (`d.path`) is `to`, or below it unless `end` (React Router's rule, without case).
    Active(String, bool),
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Lt,
    Gt,
    Le,
    Ge,
    Sub,
    Mul,
    Div,
    Rem,
}

#[derive(Debug)]
enum Key {
    Name(String),
    Index(usize),
}

/// How an attribute prints a boolean: omitted unless true (`plain`), as `name=""` when true (`bool`), or as the text "true"/"false" (`enum`, like `contentEditable`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Mode {
    Plain,
    Boolean,
    Enumerated,
}

#[derive(Debug)]
enum Node {
    Text(String),
    Print(Expr),
    /// Printed as it is, not escaped: HTML the caller made.
    Raw(Expr),
    Attr(String, Expr, Mode),
    If(Expr, Vec<Node>, Vec<Node>),
    Map(Expr, String, Option<String>, Vec<Node>),
}

pub struct Template {
    nodes: Vec<Node>,
}

fn lit(v: &Value) -> Val<'static> {
    match v {
        Value::Null => Val::Null,
        Value::Bool(b) => Val::Bool(*b),
        Value::Number(n) => n.as_i64().map(Val::Int).unwrap_or_else(|| Val::Num(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => Val::Str(Cow::Owned(s.clone())),
        Value::Array(a) => Val::Arr(a.iter().map(lit).collect()),
        Value::Object(o) => Val::Obj(o.iter().map(|(k, v)| (Cow::Owned(k.clone()), lit(v))).collect()),
    }
}

fn expr(v: &Value) -> Result<Expr, String> {
    let a = v.as_array().ok_or("an expression is an array")?;
    let op = a.first().and_then(Value::as_str).ok_or("an expression starts with its operator")?;
    let arg = |i: usize| a.get(i).ok_or_else(|| format!("{op}: missing operand {i}"));
    let b = |i: usize| -> Result<Box<Expr>, String> { Ok(Box::new(expr(arg(i)?)?)) };
    Ok(match op {
        "l" => Expr::Lit(lit(arg(1)?)),
        "p" => {
            let var = arg(1)?.as_str().ok_or("p: a variable name")?.to_string();
            let keys = a[2..].iter().map(|k| match k {
                Value::String(s) => Ok(Key::Name(s.clone())),
                Value::Number(n) => n.as_u64().map(|n| Key::Index(n as usize)).ok_or_else(|| "p: an index is a whole number".to_string()),
                _ => Err("p: a key is a string or a number".to_string()),
            });
            Expr::Path(var, keys.collect::<Result<_, _>>()?)
        }
        "!" => Expr::Not(b(1)?),
        "&&" => Expr::And(b(1)?, b(2)?),
        "||" => Expr::Or(b(1)?, b(2)?),
        "??" => Expr::Nullish(b(1)?, b(2)?),
        "?:" => Expr::Cond(b(1)?, b(2)?, b(3)?),
        "===" => Expr::Eq(b(1)?, b(2)?, true),
        "!==" => Expr::Eq(b(1)?, b(2)?, false),
        "+" => Expr::Add(b(1)?, b(2)?),
        "<" => Expr::Bin(Op::Lt, b(1)?, b(2)?),
        ">" => Expr::Bin(Op::Gt, b(1)?, b(2)?),
        "<=" => Expr::Bin(Op::Le, b(1)?, b(2)?),
        ">=" => Expr::Bin(Op::Ge, b(1)?, b(2)?),
        "-" => Expr::Bin(Op::Sub, b(1)?, b(2)?),
        "*" => Expr::Bin(Op::Mul, b(1)?, b(2)?),
        "/" => Expr::Bin(Op::Div, b(1)?, b(2)?),
        "%" => Expr::Bin(Op::Rem, b(1)?, b(2)?),
        "`" => Expr::Concat(arg(1)?.as_array().ok_or("`: parts")?.iter().map(expr).collect::<Result<_, _>>()?),
        "act" => Expr::Active(arg(1)?.as_str().ok_or("act: a path")?.to_ascii_lowercase(), arg(2)?.as_bool().unwrap_or(false)),
        other => return Err(format!("unknown operator {other}")),
    })
}

fn nodes(v: &Value) -> Result<Vec<Node>, String> {
    v.as_array().ok_or("nodes are an array")?.iter().map(node).collect()
}

fn node(v: &Value) -> Result<Node, String> {
    if let Some(s) = v.as_str() {
        return Ok(Node::Text(s.to_string()));
    }
    let a = v.as_array().ok_or("a node is a string or an array")?;
    let op = a.first().and_then(Value::as_str).ok_or("a node starts with its kind")?;
    let arg = |i: usize| a.get(i).ok_or_else(|| format!("{op}: missing operand {i}"));
    Ok(match op {
        "x" => Node::Print(expr(arg(1)?)?),
        "raw" => Node::Raw(expr(arg(1)?)?),
        "a" => Node::Attr(
            arg(1)?.as_str().ok_or("a: a name")?.to_string(),
            expr(arg(2)?)?,
            match arg(3)? {
                Value::Bool(true) => Mode::Boolean,
                Value::String(m) if m == "enum" => Mode::Enumerated,
                _ => Mode::Plain,
            },
        ),
        "if" => Node::If(expr(arg(1)?)?, nodes(arg(2)?)?, nodes(arg(3)?)?),
        "map" => Node::Map(expr(arg(1)?)?, arg(2)?.as_str().ok_or("map: item name")?.to_string(), arg(3)?.as_str().map(str::to_string), nodes(arg(4)?)?),
        other => return Err(format!("unknown node {other}")),
    })
}

impl Template {
    pub fn parse(json: &str) -> Result<Template, String> {
        let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        Ok(Template { nodes: nodes(&v)? })
    }

    /// Prints the template with `data` as the variable `d`.
    pub fn render(&self, data: &Val) -> Result<String, String> {
        let mut out = String::with_capacity(8192);
        let mut scope: Scope = Vec::new();
        print(&self.nodes, data, &mut scope, &mut out)?;
        Ok(out)
    }
}

type Scope<'r, 'a> = Vec<(&'r str, Cow<'r, Val<'a>>)>;

fn lookup<'r, 'a>(var: &str, data: &'r Val<'a>, scope: &Scope<'r, 'a>) -> Option<Cow<'r, Val<'a>>> {
    if let Some((_, v)) = scope.iter().rev().find(|(n, _)| *n == var) {
        return Some(match v {
            Cow::Borrowed(r) => Cow::Borrowed(*r),
            Cow::Owned(o) => Cow::Owned(o.clone()),
        });
    }
    (var == "d").then_some(Cow::Borrowed(data))
}

fn truthy(v: &Val) -> bool {
    match v {
        Val::Null => false,
        Val::Bool(b) => *b,
        Val::Int(n) => *n != 0,
        Val::Num(f) => *f != 0.0 && !f.is_nan(),
        Val::Str(s) => !s.is_empty(),
        _ => true,
    }
}

/// JavaScript's `String(v)` for the values that can be printed.
fn js_string(v: &Val) -> String {
    match v {
        Val::Null => "null".into(),
        Val::Bool(b) => b.to_string(),
        Val::Str(s) => s.to_string(),
        Val::Int(i) => i.to_string(),
        Val::Num(f) => number_string(*f),
        Val::Arr(a) => a.iter().map(|x| if matches!(x, Val::Null) { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Val::Obj(_) => "[object Object]".into(),
    }
}

/// JavaScript's `String(n)` for a number: the shortest digits that read back as the same number, in decimal form from 1e-6 up to 1e21 and in exponent form outside.
fn number_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f == 0.0 {
        return "0".into(); // also -0
    }
    if f.is_infinite() {
        return if f < 0.0 { "-Infinity" } else { "Infinity" }.into();
    }
    // `{:e}` gives the shortest round-trip digits as "d.ddde<exp>"
    let sci = format!("{:e}", f.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap_or(0) + 1; // the decimal point sits after the n-th digit
    let sign = if f < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            format!("{}.{}e{es}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

fn num(v: &Val) -> Option<f64> {
    match v {
        Val::Int(i) => Some(*i as f64),
        Val::Num(f) => Some(*f),
        _ => None,
    }
}

/// `===`: numbers by value, strings by content, objects and arrays never (they would be the same object only).
fn strict_eq(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Null, Val::Null) => true,
        (Val::Bool(x), Val::Bool(y)) => x == y,
        (Val::Str(x), Val::Str(y)) => x == y,
        (x, y) => match (num(x), num(y)) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

/// Evaluates without copying data: a path gives a reference into the data.
fn eval<'r, 'a>(e: &'r Expr, data: &'r Val<'a>, scope: &Scope<'r, 'a>) -> Cow<'r, Val<'a>> {
    match e {
        Expr::Lit(v) => Cow::Borrowed(v),
        Expr::Path(var, keys) => {
            let mut cur = match lookup(var, data, scope) {
                Some(v) => v,
                None => return Cow::Owned(Val::Null),
            };
            for k in keys {
                cur = match (k, cur) {
                    (Key::Name(n), Cow::Borrowed(Val::Obj(fields))) => match fields.iter().find(|(f, _)| f == n.as_str()) {
                        Some((_, v)) => Cow::Borrowed(v),
                        None => return Cow::Owned(Val::Null),
                    },
                    (Key::Name(n), Cow::Borrowed(Val::Arr(a))) if n == "length" => return Cow::Owned(Val::Int(a.len() as i64)),
                    (Key::Name(n), Cow::Borrowed(Val::Str(s))) if n == "length" => return Cow::Owned(Val::Int(s.encode_utf16().count() as i64)),
                    (Key::Index(i), Cow::Borrowed(Val::Arr(a))) => match a.get(*i) {
                        Some(v) => Cow::Borrowed(v),
                        None => return Cow::Owned(Val::Null),
                    },
                    _ => return Cow::Owned(Val::Null),
                };
            }
            cur
        }
        Expr::Not(a) => Cow::Owned(Val::Bool(!truthy(&eval(a, data, scope)))),
        Expr::And(a, b) => {
            let l = eval(a, data, scope);
            if truthy(&l) { eval(b, data, scope) } else { l }
        }
        Expr::Or(a, b) => {
            let l = eval(a, data, scope);
            if truthy(&l) { l } else { eval(b, data, scope) }
        }
        Expr::Nullish(a, b) => {
            let l = eval(a, data, scope);
            if matches!(*l, Val::Null) { eval(b, data, scope) } else { l }
        }
        Expr::Cond(c, a, b) => {
            if truthy(&eval(c, data, scope)) { eval(a, data, scope) } else { eval(b, data, scope) }
        }
        Expr::Eq(a, b, equal) => Cow::Owned(Val::Bool(strict_eq(&eval(a, data, scope), &eval(b, data, scope)) == *equal)),
        Expr::Add(a, b) => {
            let (l, r) = (eval(a, data, scope), eval(b, data, scope));
            Cow::Owned(match (num(&l), num(&r), &*l, &*r) {
                (_, _, Val::Int(x), Val::Int(y)) if x.checked_add(*y).is_some() => Val::Int(x + y),
                (Some(x), Some(y), _, _) => Val::Num(x + y),
                _ => Val::Str(Cow::Owned(js_string(&l) + &js_string(&r))),
            })
        }
        Expr::Bin(op, a, b) => {
            let (l, r) = (eval(a, data, scope), eval(b, data, scope));
            Cow::Owned(binary(*op, &l, &r))
        }
        Expr::Concat(parts) => {
            let mut s = String::new();
            for p in parts {
                match &*eval(p, data, scope) {
                    Val::Str(t) => s.push_str(t),
                    other => s.push_str(&js_string(other)),
                }
            }
            Cow::Owned(Val::Str(Cow::Owned(s)))
        }
        Expr::Active(to, end) => {
            let here = match data.get("path") {
                Some(Val::Str(p)) => p.to_ascii_lowercase(),
                _ => return Cow::Owned(Val::Bool(false)),
            };
            let active = here == *to || (!*end && here.starts_with(to.as_str()) && here.as_bytes().get(to.len()) == Some(&b'/'));
            Cow::Owned(Val::Bool(active))
        }
    }
}

/// The numeric and relational operators with JavaScript's results for numbers (and strings, for the relational ones); anything else is NaN or false, as JavaScript says for most of it.
fn binary<'a>(op: Op, l: &Val, r: &Val) -> Val<'a> {
    if let (Val::Str(x), Val::Str(y)) = (l, r) {
        let ord = x.encode_utf16().cmp(y.encode_utf16());
        return match op {
            Op::Lt => Val::Bool(ord.is_lt()),
            Op::Gt => Val::Bool(ord.is_gt()),
            Op::Le => Val::Bool(ord.is_le()),
            Op::Ge => Val::Bool(ord.is_ge()),
            _ => Val::Num(f64::NAN),
        };
    }
    let (Some(x), Some(y)) = (num(l), num(r)) else {
        return match op {
            Op::Lt | Op::Gt | Op::Le | Op::Ge => Val::Bool(false),
            _ => Val::Num(f64::NAN),
        };
    };
    match op {
        Op::Lt => Val::Bool(x < y),
        Op::Gt => Val::Bool(x > y),
        Op::Le => Val::Bool(x <= y),
        Op::Ge => Val::Bool(x >= y),
        _ => {
            if let (Val::Int(a), Val::Int(b)) = (l, r) {
                let whole = match op {
                    Op::Sub => a.checked_sub(*b),
                    Op::Mul => a.checked_mul(*b),
                    Op::Rem if *b != 0 => a.checked_rem(*b),
                    _ => None,
                };
                if let Some(v) = whole {
                    return Val::Int(v);
                }
            }
            Val::Num(match op {
                Op::Sub => x - y,
                Op::Mul => x * y,
                Op::Div => x / y,
                _ => x % y,
            })
        }
    }
}

fn escape(s: &str, out: &mut String) {
    let mut last = 0;
    for (i, b) in s.bytes().enumerate() {
        let rep = match b {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            b'\'' => "&#x27;",
            _ => continue,
        };
        out.push_str(&s[last..i]);
        out.push_str(rep);
        last = i + 1;
    }
    out.push_str(&s[last..]);
}

fn print<'r, 'a>(ns: &'r [Node], data: &'r Val<'a>, scope: &mut Scope<'r, 'a>, out: &mut String) -> Result<(), String> {
    for n in ns {
        match n {
            Node::Text(t) => out.push_str(t),
            Node::Print(e) => match &*eval(e, data, scope) {
                Val::Null | Val::Bool(_) => {}
                Val::Str(s) => escape(s, out),
                v @ (Val::Int(_) | Val::Num(_)) => out.push_str(&js_string(v)),
                other => escape(&js_string(other), out),
            },
            Node::Raw(e) => match &*eval(e, data, scope) {
                Val::Str(s) => out.push_str(s),
                Val::Null | Val::Bool(_) => {}
                other => out.push_str(&js_string(other)),
            },
            Node::Attr(name, e, mode) => match &*eval(e, data, scope) {
                Val::Null => {}
                Val::Bool(b) => match mode {
                    Mode::Boolean if *b => {
                        out.push(' ');
                        out.push_str(name);
                        out.push_str("=\"\"");
                    }
                    Mode::Enumerated => {
                        out.push(' ');
                        out.push_str(name);
                        out.push_str(if *b { "=\"true\"" } else { "=\"false\"" });
                    }
                    _ => {}
                },
                v => {
                    out.push(' ');
                    out.push_str(name);
                    out.push_str("=\"");
                    match v {
                        Val::Str(s) => escape(s, out),
                        other => escape(&js_string(other), out),
                    }
                    out.push('"');
                }
            },
            Node::If(c, t, f) => {
                if truthy(&eval(c, data, scope)) { print(t, data, scope, out)? } else { print(f, data, scope, out)? }
            }
            Node::Map(list, item, index, body) => {
                if let Cow::Borrowed(Val::Arr(items)) = eval(list, data, scope) {
                    for (i, v) in items.iter().enumerate() {
                        let depth = scope.len();
                        scope.push((item.as_str(), Cow::Borrowed(v)));
                        if let Some(ix) = index {
                            scope.push((ix.as_str(), Cow::Owned(Val::Int(i as i64))));
                        }
                        print(body, data, scope, out)?;
                        scope.truncate(depth);
                    }
                }
            }
        }
    }
    Ok(())
}

static REGISTRY: RwLock<Vec<std::sync::Arc<Template>>> = RwLock::new(Vec::new());
static NAMES: RwLock<Option<HashMap<String, u32>>> = RwLock::new(None);

/// Registers a template under a name (a second registration of the name replaces it); returns its id.
pub fn register(name: &str, json: &str) -> Result<u32, String> {
    let t = std::sync::Arc::new(Template::parse(json)?);
    let mut names = NAMES.write().unwrap();
    let map = names.get_or_insert_with(HashMap::new);
    let mut reg = REGISTRY.write().unwrap();
    if let Some(id) = map.get(name) {
        reg[*id as usize] = t;
        return Ok(*id);
    }
    reg.push(t);
    let id = (reg.len() - 1) as u32;
    map.insert(name.to_string(), id);
    Ok(id)
}

/// Prints template `id` with the JSON in `data`.
pub fn render(id: u32, data: &str) -> Result<String, String> {
    let t = REGISTRY.read().unwrap().get(id as usize).cloned().ok_or("no such template")?;
    let v = json::parse(data)?;
    t.render(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(t: &str, d: &str) -> String {
        Template::parse(t).unwrap().render(&json::parse(d).unwrap()).unwrap()
    }

    #[test]
    fn numbers_print_as_javascript_prints_them() {
        for (n, want) in [
            (0.0, "0"), (-0.0, "0"), (1.0, "1"), (-12.5, "-12.5"), (0.1 + 0.2, "0.30000000000000004"), (100.0, "100"), (1e20, "100000000000000000000"),
            (1e21, "1e+21"), (1.5e21, "1.5e+21"), (123456789012345680000.0, "123456789012345680000"), (0.000001, "0.000001"), (1e-7, "1e-7"), (1.5e-7, "1.5e-7"),
            (-2.5e-10, "-2.5e-10"), (f64::NAN, "NaN"), (f64::INFINITY, "Infinity"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(number_string(n), want, "{n:e}");
        }
    }

    #[test]
    fn prints_text_escaped_and_static_html_as_it_is() {
        assert_eq!(run(r#"["<p>", ["x", ["p","d","a"]], "</p>"]"#, r#"{"a":"<b>&\"'"}"#), "<p>&lt;b&gt;&amp;&quot;&#x27;</p>");
    }

    #[test]
    fn follows_javascripts_rules_for_what_prints() {
        let t = r#"[["x",["p","d","n"]],"|",["x",["p","d","z"]],"|",["x",["p","d","t"]],"|",["x",["p","d","f"]],"|",["x",["p","d","null"]],"|",["x",["p","d","missing"]],"|",["x",["p","d","big"]],"|",["x",["p","d","frac"]]]"#;
        assert_eq!(run(t, r#"{"n":0,"z":"","t":true,"f":false,"null":null,"big":1200,"frac":0.5}"#), "0||||||1200|0.5");
    }

    #[test]
    fn conditions_and_operators() {
        let d = r#"{"v":{"name":"Ada"},"a":0,"b":"x","list":[1,2,3]}"#;
        assert_eq!(run(r#"[["if",["p","d","v"],[["x",["p","d","v","name"]]],["no"]]]"#, d), "Ada");
        assert_eq!(run(r#"[["x",["&&",["p","d","a"],["l","shown"]]]]"#, d), "0"); // 0 && x is 0, which prints
        assert_eq!(run(r#"[["x",["||",["p","d","a"],["l","fallback"]]]]"#, d), "fallback");
        assert_eq!(run(r#"[["x",["??",["p","d","a"],["l","fallback"]]]]"#, d), "0");
        assert_eq!(run(r#"[["x",["?:",["===",["p","d","b"],["l","x"]],["l","yes"],["l","no"]]]]"#, d), "yes");
        assert_eq!(run(r#"[["x",["+",["l",1],["l",2]]],",",["x",["+",["l","a"],["l",2]]]]"#, d), "3,a2");
        assert_eq!(run(r#"[["x",["`",[["l","n="],["p","d","list","length"],["l","/"],["p","d","list",1]]]]]"#, d), "n=3/2");
    }

    #[test]
    fn attributes_are_left_out_when_empty() {
        let t = r#"["<a",["a","href",["p","d","h"],false],["a","class",["p","d","c"],false],["a","disabled",["p","d","off"],true],["a","hidden",["p","d","on"],true],">x</a>"]"#;
        assert_eq!(run(t, r#"{"h":"/a?b=1&c=2","c":null,"off":false,"on":true}"#), r#"<a href="/a?b=1&amp;c=2" hidden="">x</a>"#);
        assert_eq!(run(r#"["<p",["a","contentEditable",["p","d","t"],"enum"],["a","spellCheck",["p","d","f"],"enum"],">"]"#, r#"{"t":true,"f":false}"#), r#"<p contentEditable="true" spellCheck="false">"#);
    }

    #[test]
    fn maps_over_arrays_with_an_index_and_nests() {
        let t = r#"["<ul>",["map",["p","d","rows"],"r","i",["<li>",["x",["p","i"]],":",["x",["p","r","name"]],["map",["p","r","tags"],"t",null,["[",["x",["p","t"]],"]"]],"</li>"]],"</ul>"]"#;
        assert_eq!(run(t, r#"{"rows":[{"name":"a","tags":["x","y"]},{"name":"b","tags":[]}]}"#), "<ul><li>0:a[x][y]</li><li>1:b</li></ul>");
    }

    #[test]
    fn arithmetic_and_comparisons() {
        let d = r#"{"i":7,"f":2.5,"s":"b"}"#;
        let p = |op: &str, a: &str, b: &str| run(&format!(r#"[["x",["{op}",["p","d","{a}"],["p","d","{b}"]]]]"#), d);
        assert_eq!(p("-", "i", "f"), "4.5");
        assert_eq!(p("*", "i", "f"), "17.5");
        assert_eq!(p("/", "i", "i"), "1");
        assert_eq!(p("%", "i", "i"), "0");
        assert_eq!(run(r#"[["x",["%",["l",-7],["l",3]]]]"#, d), "-1"); // the sign of the dividend, as in JavaScript
        assert_eq!(p("<", "f", "i"), "");
        assert_eq!(run(r#"[["x",["?:",["<",["p","d","f"],["p","d","i"]],["l","lt"],["l","ge"]]]]"#, d), "lt");
        assert_eq!(run(r#"[["x",["?:",[">=",["p","d","s"],["l","a"]],["l","after"],["l","before"]]]]"#, d), "after");
        assert_eq!(run(r#"[["x",["-",["p","d","s"],["l",1]]]]"#, d), "NaN");
    }

    #[test]
    fn raw_and_navigation_links() {
        let d = r#"{"path":"/Products/42","html":"<b>x</b>"}"#;
        assert_eq!(run(r#"[["raw",["p","d","html"]]]"#, d), "<b>x</b>");
        let act = |to: &str, end: bool| run(&format!(r#"[["x",["?:",["act","{to}",{end}],["l","on"],["l","off"]]]]"#), d);
        assert_eq!(act("/products", false), "on");
        assert_eq!(act("/products", true), "off");
        assert_eq!(act("/products/42", true), "on");
        assert_eq!(act("/prod", false), "off");
        assert_eq!(act("/", false), "off"); // the same rule as the framework's NavLink (link.tsx): "/" is active only on "/" and on paths below it with another slash
    }

    #[test]
    fn registered_templates_render_and_can_be_replaced() {
        let id = register("t1", r#"["a",["x",["p","d","v"]]]"#).unwrap();
        assert_eq!(render(id, r#"{"v":1}"#).unwrap(), "a1");
        assert_eq!(register("t1", r#"["b"]"#).unwrap(), id);
        assert_eq!(render(id, "{}").unwrap(), "b");
        assert!(register("bad", r#"[["nope"]]"#).is_err());
    }
}

#[cfg(test)]
mod timing {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore] // cargo test --release -p archlast-serve-core timing -- --ignored --nocapture
    fn where_the_time_goes() {
        let rows: Vec<String> = (0..100).map(|i| format!(r#"{{"id":{i},"name":"Anvil Bolt {i}","sku":"SKU-{i:05}","price":"$1,234.56","stock":{},"added":"Jan {}, 2026"}}"#, i * 3 % 500, i % 28 + 1)).collect();
        let data = format!(r#"{{"rows":[{}]}}"#, rows.join(","));
        let t = Template::parse(r#"["<table><tbody>",["map",["p","d","rows"],"p",null,["<tr><td>",["x",["p","p","sku"]],"</td><td>",["x",["p","p","name"]],"</td><td>",["x",["p","p","price"]],"</td><td>",["x",["p","p","stock"]],"</td><td>",["x",["p","p","added"]],"</td></tr>"]],"</tbody></table>"]"#).unwrap();
        let v = json::parse(&data).unwrap();
        let n = 20_000;
        let a = Instant::now();
        for _ in 0..n { std::hint::black_box(json::parse(&data).unwrap()); }
        let parse = a.elapsed().as_secs_f64() * 1e6 / n as f64;
        let b = Instant::now();
        for _ in 0..n { std::hint::black_box(t.render(&v).unwrap()); }
        let render = b.elapsed().as_secs_f64() * 1e6 / n as f64;
        println!("data {} bytes: parse {parse:.1} us, render {render:.1} us", data.len());
    }
}
