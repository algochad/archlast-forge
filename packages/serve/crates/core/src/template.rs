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
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug)]
enum Expr {
    Lit(Value),
    Path(String, Vec<Key>),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Nullish(Box<Expr>, Box<Expr>),
    Cond(Box<Expr>, Box<Expr>, Box<Expr>),
    Eq(Box<Expr>, Box<Expr>, bool),
    Add(Box<Expr>, Box<Expr>),
    Concat(Vec<Expr>),
}

#[derive(Debug)]
enum Key {
    Name(String),
    Index(usize),
}

#[derive(Debug)]
enum Node {
    Text(String),
    Print(Expr),
    Attr(String, Expr, bool),
    If(Expr, Vec<Node>, Vec<Node>),
    Map(Expr, String, Option<String>, Vec<Node>),
}

pub struct Template {
    nodes: Vec<Node>,
}

fn expr(v: &Value) -> Result<Expr, String> {
    let a = v.as_array().ok_or("an expression is an array")?;
    let op = a.first().and_then(Value::as_str).ok_or("an expression starts with its operator")?;
    let arg = |i: usize| a.get(i).ok_or_else(|| format!("{op}: missing operand {i}"));
    let b = |i: usize| -> Result<Box<Expr>, String> { Ok(Box::new(expr(arg(i)?)?)) };
    Ok(match op {
        "l" => Expr::Lit(arg(1)?.clone()),
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
        "`" => Expr::Concat(arg(1)?.as_array().ok_or("`: parts")?.iter().map(expr).collect::<Result<_, _>>()?),
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
        "a" => Node::Attr(arg(1)?.as_str().ok_or("a: a name")?.to_string(), expr(arg(2)?)?, arg(3)?.as_bool().unwrap_or(false)),
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
    pub fn render(&self, data: &Value) -> Result<String, String> {
        let mut out = String::with_capacity(4096);
        let mut scope: Scope = Vec::new();
        print(&self.nodes, data, &mut scope, &mut out)?;
        Ok(out)
    }
}

type Scope<'a> = Vec<(&'a str, Cow<'a, Value>)>;

fn lookup<'a, 'b>(var: &str, data: &'a Value, scope: &'b Scope<'a>) -> Option<&'b Value>
where
    'a: 'b,
{
    if let Some((_, v)) = scope.iter().rev().find(|(n, _)| *n == var) {
        return Some(v.as_ref());
    }
    (var == "d").then_some(data)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// JavaScript's `String(v)` for the values that can be printed.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if f.fract() == 0.0 && f.abs() < 1e21 {
                    format!("{}", f as i128)
                } else {
                    format!("{f}")
                }
            }
        }
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Evaluates without copying data: a path gives a reference into the data.
fn eval<'a>(e: &'a Expr, data: &'a Value, scope: &Scope<'a>) -> Cow<'a, Value> {
    match e {
        Expr::Lit(v) => Cow::Borrowed(v),
        Expr::Path(var, keys) => {
            let mut cur = match lookup(var, data, scope) {
                Some(v) => v,
                None => return Cow::Owned(Value::Null),
            };
            for k in keys {
                cur = match (k, cur) {
                    (Key::Name(n), Value::Object(o)) => match o.get(n) {
                        Some(v) => v,
                        None => return Cow::Owned(Value::Null),
                    },
                    (Key::Name(n), Value::Array(a)) if n == "length" => return Cow::Owned(Value::from(a.len())),
                    (Key::Name(n), Value::String(s)) if n == "length" => return Cow::Owned(Value::from(s.encode_utf16().count())),
                    (Key::Index(i), Value::Array(a)) => match a.get(*i) {
                        Some(v) => v,
                        None => return Cow::Owned(Value::Null),
                    },
                    _ => return Cow::Owned(Value::Null),
                };
            }
            // `cur` borrows from the data or from the scope, both of which live as long as the render: see `print`.
            // SAFETY: values pushed on the scope are references into `data`, or small owned values that stay until their loop ends, after every use of this result.
            Cow::Borrowed(unsafe { &*(cur as *const Value) })
        }
        Expr::Not(a) => Cow::Owned(Value::Bool(!truthy(&eval(a, data, scope)))),
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
            if l.is_null() { eval(b, data, scope) } else { l }
        }
        Expr::Cond(c, a, b) => {
            if truthy(&eval(c, data, scope)) { eval(a, data, scope) } else { eval(b, data, scope) }
        }
        Expr::Eq(a, b, equal) => Cow::Owned(Value::Bool((*eval(a, data, scope) == *eval(b, data, scope)) == *equal)),
        Expr::Add(a, b) => {
            let (l, r) = (eval(a, data, scope), eval(b, data, scope));
            Cow::Owned(match (&*l, &*r) {
                (Value::Number(x), Value::Number(y)) => Value::from(x.as_f64().unwrap_or(0.0) + y.as_f64().unwrap_or(0.0)),
                _ => Value::String(js_string(&l) + &js_string(&r)),
            })
        }
        Expr::Concat(parts) => Cow::Owned(Value::String(parts.iter().map(|p| js_string(&eval(p, data, scope))).collect())),
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

fn print<'a>(ns: &'a [Node], data: &'a Value, scope: &mut Scope<'a>, out: &mut String) -> Result<(), String> {
    for n in ns {
        match n {
            Node::Text(t) => out.push_str(t),
            Node::Print(e) => match &*eval(e, data, scope) {
                Value::Null | Value::Bool(_) => {}
                Value::String(s) => escape(s, out),
                v @ Value::Number(_) => out.push_str(&js_string(v)),
                other => escape(&js_string(other), out),
            },
            Node::Attr(name, e, boolean) => match &*eval(e, data, scope) {
                Value::Null | Value::Bool(false) => {}
                Value::Bool(true) => {
                    if *boolean {
                        out.push(' ');
                        out.push_str(name);
                        out.push_str("=\"\"");
                    }
                }
                v => {
                    out.push(' ');
                    out.push_str(name);
                    out.push_str("=\"");
                    match v {
                        Value::String(s) => escape(s, out),
                        other => escape(&js_string(other), out),
                    }
                    out.push('"');
                }
            },
            Node::If(c, t, f) => {
                if truthy(&eval(c, data, scope)) { print(t, data, scope, out)? } else { print(f, data, scope, out)? }
            }
            Node::Map(list, item, index, body) => {
                if let Value::Array(items) = &*eval(list, data, scope) {
                    // The list borrows from the data (or a literal in the template), which outlives the render.
                    let items: &'a [Value] = unsafe { &*(items.as_slice() as *const [Value]) };
                    for (i, v) in items.iter().enumerate() {
                        let depth = scope.len();
                        scope.push((item.as_str(), Cow::Borrowed(v)));
                        if let Some(ix) = index {
                            scope.push((ix.as_str(), Cow::Owned(Value::from(i))));
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
    let v: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    t.render(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(t: &str, d: &str) -> String {
        Template::parse(t).unwrap().render(&serde_json::from_str(d).unwrap()).unwrap()
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
    }

    #[test]
    fn maps_over_arrays_with_an_index_and_nests() {
        let t = r#"["<ul>",["map",["p","d","rows"],"r","i",["<li>",["x",["p","i"]],":",["x",["p","r","name"]],["map",["p","r","tags"],"t",null,["[",["x",["p","t"]],"]"]],"</li>"]],"</ul>"]"#;
        assert_eq!(run(t, r#"{"rows":[{"name":"a","tags":["x","y"]},{"name":"b","tags":[]}]}"#), "<ul><li>0:a[x][y]</li><li>1:b</li></ul>");
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
