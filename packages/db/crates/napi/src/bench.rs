//! Timings of the engine's operations without JavaScript or Node-API around them: `cargo test --release bench -- --ignored --nocapture`.
use crate::engine::{Engine, Options};
use std::time::Instant;

fn engine() -> Engine {
    let dir = std::env::temp_dir().join(format!("afx-bench-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut e = Engine::open(dir.join("a.db").to_str().unwrap(), &Options { readers: 2, mmap_bytes: None, cache_kib: None, cache_entries: 20_000, cache_bytes: 32 << 20 }).unwrap();
    let spec = r#"{"tables":[{"name":"items","creation":{"fields":[],"sql":"afx_c"},"indexes":[["by_item",{"fields":["itemId"],"sql":"afx_by_item"}]],"search":[],
        "fields":{"itemId":{"kind":"number","optional":false},"name":{"kind":"string","optional":false},"quantity":{"kind":"number","optional":false}},"strict":true}]}"#;
    #[derive(serde::Deserialize)]
    struct Spec {
        tables: Vec<crate::schema::TableSpec>,
    }
    e.migrate(serde_json::from_str::<Spec>(spec).unwrap().tables).unwrap();
    e
}

fn time(name: &str, n: usize, mut f: impl FnMut(usize)) {
    for i in 0..n.min(2000) {
        f(i);
    }
    let t = Instant::now();
    for i in 0..n {
        f(i);
    }
    println!("{name:<40} {:>7.2} µs/op", t.elapsed().as_secs_f64() * 1e6 / n as f64);
}

#[test]
#[ignore]
fn bench() {
    let mut e = engine();
    let w = e.begin_write();
    e.writer_sql("BEGIN IMMEDIATE").unwrap();
    let mut ids = vec![];
    for i in 1..=1000 {
        ids.push(e.insert(w, "items", &[format!(r#"{{"itemId":{i},"name":"item-{i}","quantity":{}}}"#, i % 100)], 1 << 20, false).unwrap().remove(0));
    }
    e.writer_sql("COMMIT").unwrap();
    e.end_tx(w, true).unwrap();

    let r = e.begin_read(false).unwrap();
    let list = r#"{"table":"items","index":"by_item","bounds":[{"op":">=","value":1},{"op":"<=","value":20}],"boundField":"itemId"}"#;
    time("list20 query (uncached tx)", 100_000, |_| {
        e.query(r, "items", list).unwrap();
    });
    let proj = r#"{"table":"items","index":"by_item","bounds":[{"op":">=","value":1},{"op":"<=","value":20}],"boundField":"itemId","projection":["name","quantity"]}"#;
    time("list20 select(name, quantity)", 100_000, |_| {
        e.query_full(r, "items", proj).unwrap();
    });
    time("list20 count", 100_000, |_| {
        e.count(r, "items", list).unwrap();
    });
    time("list20 paginate(10)", 50_000, |_| {
        e.paginate(r, "items", list, 10, None, 0, false).unwrap();
    });
    let one = |i: usize| format!(r#"{{"table":"items","index":"by_item","eqs":[["itemId",{}]],"limit":1}}"#, i % 1000 + 1);
    time("first by index", 200_000, |i| {
        e.query(r, "items", &one(i)).unwrap();
    });
    time("get_raw by id", 200_000, |i| {
        e.get_raw(r, &ids[i % 1000]).unwrap();
    });
    e.end_tx(r, true).unwrap();

    let doc = r#"{"itemId":1234,"name":"w","quantity":1}"#;
    time("  (parse a 3-field doc into a Value)", 500_000, |_| {
        let v: serde_json::Value = serde_json::from_str(doc).unwrap();
        std::hint::black_box(v);
    });
    time("  (new_id)", 500_000, |_| {
        std::hint::black_box(crate::engine::new_id_for_bench("items"));
    });
    let w = e.begin_write();
    e.writer_sql("BEGIN IMMEDIATE").unwrap();
    let mut n = 0;
    time("insert", 100_000, |i| {
        n += 1;
        e.insert(w, "items", &[format!(r#"{{"itemId":{},"name":"w","quantity":1}}"#, 2000 + i)], 1 << 20, false).unwrap();
    });
    {
        let c = e.writer_conn();
        let mut k = 0usize;
        time("  raw SQLite INSERT", 100_000, |i| {
            k += 1;
            let i = k + 10 * i * 0;
            c.prepare_cached("INSERT INTO \"items\" (\"_id\", \"_creationTime\", \"doc\") VALUES (?1, ?2, ?3)")
                .unwrap()
                .execute(rusqlite::params![format!("items:{:032x}", 9_000_000 + k), 1731083225123.456 + k as f64, format!(r#"{{"itemId":{},"name":"w","quantity":1}}"#, 5_000_000 + k)])
                .unwrap();
        });
        time("  raw SQLite UPDATE doc", 100_000, |i| {
            c.prepare_cached("UPDATE \"items\" SET \"doc\" = ?1 WHERE \"_id\" = ?2").unwrap().execute(rusqlite::params![format!(r#"{{"itemId":{},"name":"u","quantity":{i}}}"#, i % 1000 + 1), &ids[i % 1000]]).unwrap();
        });
        time("  raw SQLite SELECT doc by _id", 100_000, |i| {
            let _: String = c.prepare_cached("SELECT \"doc\" FROM \"items\" WHERE \"_id\" = ?1").unwrap().query_row([&ids[i % 1000]], |r| r.get(0)).unwrap();
        });
    }
    time("change patch (real)", 100_000, |i| {
        e.change(w, &ids[i % 1000], &format!(r#"{{"quantity":{i}}}"#), true, 1 << 20, false).unwrap();
    });
    time("change patch (no-op)", 100_000, |i| {
        e.change(w, &ids[i % 1000], r#"{"quantity":7}"#, true, 1 << 20, false).unwrap();
    });
    let fresh: Vec<String> = (0..60_000).map(|i| e.insert(w, "items", &[format!(r#"{{"itemId":{},"name":"d","quantity":1}}"#, 9_000_000 + i)], 1 << 20, false).unwrap().remove(0)).collect();
    time("delete", 50_000, |i| {
        e.delete(w, &fresh[i]).unwrap();
    });
    e.writer_sql("COMMIT").unwrap();
    e.end_tx(w, true).unwrap();
    let _ = n;
}
