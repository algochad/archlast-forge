//! JSON text exactly as JavaScript's `JSON.stringify` writes it, where it differs from serde_json's: numbers. Reactivity topics are made of such text
//! (`notes:by_tag:["a",1]`), and the engine's topics must equal the ones JavaScript makes for the same values (another server on the bus may be JavaScript).

use serde_json::Value;

/// `Number.prototype.toString` for a finite number.
pub fn number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if !x.is_finite() {
        return "null".into(); // JSON.stringify(NaN) and of Infinity are null
    }
    let neg = x < 0.0;
    // the shortest digits that read back as x, in scientific form: d.ddde±x
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let e: i32 = exp.parse().unwrap();
    let k = digits.len() as i32;
    let n = e + 1; // the position of the decimal point relative to the digits
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let mant = if k == 1 { digits.clone() } else { format!("{}.{}", &digits[..1], &digits[1..]) };
        format!("{mant}e{sign}{}", (n - 1).abs())
    };
    if neg { format!("-{body}") } else { body }
}

/// `number(x)` written straight into `out`: the common numbers (whole, or plain decimals) without an allocation, the rest as `number` makes them.
pub fn push_number(out: &mut String, x: f64) {
    use std::fmt::Write;
    if x == 0.0 {
        out.push('0');
    } else if !x.is_finite() {
        out.push_str("null");
    } else {
        let a = x.abs();
        if a < 9007199254740992.0 && x.fract() == 0.0 {
            let _ = write!(out, "{}", x as i64);
        } else if (1e-6..1e21).contains(&a) {
            // Rust writes the shortest digits that read back as x, as JavaScript does, and never an exponent: in this range neither does JavaScript
            let _ = write!(out, "{x}");
        } else {
            out.push_str(&number(x));
        }
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write(&mut out, v);
    out
}

/// A string literal as `JSON.stringify` writes it: written straight out when nothing needs escaping.
pub fn write_str(out: &mut String, s: &str) {
    string(out, s)
}

fn string(out: &mut String, s: &str) {
    if s.bytes().all(|b| b >= 0x20 && b != b'"' && b != b'\\') {
        out.push('"');
        out.push_str(s);
        out.push('"');
    } else {
        out.push_str(&serde_json::to_string(s).unwrap());
    }
}

/// `JSON.stringify` of an object held as a map, without making a `Value` of it.
pub fn stringify_map(m: &serde_json::Map<String, Value>) -> String {
    let mut out = String::new();
    write_map(&mut out, m);
    out
}

fn write_map(out: &mut String, m: &serde_json::Map<String, Value>) {
    out.push('{');
    for (i, (k, x)) in m.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        string(out, k);
        out.push(':');
        write(out, x);
    }
    out.push('}');
}

pub fn write(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_i64() {
            Some(i) if i.unsigned_abs() < (1u64 << 53) => out.push_str(&i.to_string()),
            _ => out.push_str(&number(n.as_f64().unwrap_or(f64::NAN))),
        },
        Value::String(s) => string(out, s),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, x);
            }
            out.push(']');
        }
        Value::Object(m) => write_map(out, m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn push_number_is_number() {
        let mut seed = 0x9e3779b97f4a7c15u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut cases = vec![0.0, -0.0, 1.0, -1.5, 0.1, 1e21, 1e-7, 123456789012345680000.0, 1e20, 999999999999999900000.0, 1731083225123.456, 2.5e-7, 0.000001, 9007199254740993.0, f64::NAN, f64::INFINITY, 5e-324, 1.7976931348623157e308];
        for _ in 0..20000 {
            let bits = next();
            cases.push(f64::from_bits(bits));
            cases.push((bits % 2_000_000_000_000) as f64 / 1000.0);
            cases.push((bits % 100_000) as f64 * 1e15 / 7.0);
        }
        for x in cases {
            let mut got = String::new();
            push_number(&mut got, x);
            assert_eq!(got, number(x), "{x:e}");
        }
    }

    #[test]
    fn strings_as_javascript_writes_them() {
        let v = serde_json::json!({"a\"b": "x\ny\\z\u{1}é漢😀", "plain": "ok"});
        assert_eq!(stringify(&v), "{\"a\\\"b\":\"x\\ny\\\\z\\u0001é漢😀\",\"plain\":\"ok\"}");
    }

    #[test]
    fn numbers_as_javascript_writes_them() {
        for (x, want) in [(1.0, "1"), (-1.5, "-1.5"), (0.1, "0.1"), (1e21, "1e+21"), (1e-7, "1e-7"), (123456789012345680000.0, "123456789012345680000"), (1.5e300, "1.5e+300"), (0.000001, "0.000001"), (2.5e-7, "2.5e-7"), (100.0, "100"), (-0.0, "0")] {
            assert_eq!(number(x), want, "{x}");
        }
    }
}
