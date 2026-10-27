//! The program tables are copied from TypeScript; fail if the sources change without this crate following.

use std::collections::BTreeSet;
use std::path::PathBuf;

use ge_parse::programs::{
    JITO_TIP_ACCOUNTS, NON_MEMECOIN_MINTS, PLUMBING, STREAM_DEFAULT_PROGRAMS, VENUE_LABELS,
    VENUE_RANK,
};

fn src(rel: &str) -> String {
    std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../..")
            .join(rel),
    )
    .expect(rel)
}

/// The body of `export const NAME ... = <open> ... <close>` in a TS file.
fn block(text: &str, name: &str, open: char, close: char) -> String {
    let start = text
        .find(&format!("export const {name}"))
        .unwrap_or_else(|| panic!("{name} not found"));
    let rest = &text[start..];
    let rest = &rest[rest.find(open).expect("open")..];
    rest[..rest.find(close).expect("close") + 1].to_string()
}

/// `"id": "label"` / `id: "label"` pairs.
fn pairs(body: &str) -> BTreeSet<(String, String)> {
    body.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.starts_with("//") {
                return None;
            }
            let (k, v) = l.split_once(':')?;
            let k = k.trim().trim_matches('"').to_string();
            let v = v.split('"').nth(1)?.to_string();
            Some((k, v))
        })
        .collect()
}

fn strings(body: &str) -> Vec<String> {
    body.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .flat_map(|l| {
            l.split('"')
                .skip(1)
                .step_by(2)
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn tables_match_typescript() {
    let p = src("agent/src/chain/programs.ts");
    let mut ts: BTreeSet<_> = pairs(&block(&p, "VENUES", '{', '}'));
    let venues: BTreeSet<String> = ts.iter().map(|(k, _)| k.clone()).collect();
    ts.extend(pairs(&block(&p, "LABEL_ONLY_VENUES", '{', '}')));
    let rs: BTreeSet<_> = VENUE_LABELS
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    assert_eq!(rs, ts, "VENUE_LABELS");
    assert_eq!(
        STREAM_DEFAULT_PROGRAMS
            .iter()
            .map(|s| s.to_string())
            .collect::<BTreeSet<_>>(),
        venues,
        "VENUES"
    );
    assert_eq!(
        VENUE_RANK.to_vec(),
        strings(&block(&p, "VENUE_RANK", '[', ']')),
        "VENUE_RANK"
    );
    assert_eq!(
        PLUMBING
            .iter()
            .map(|s| s.to_string())
            .collect::<BTreeSet<_>>(),
        strings(&block(&p, "PLUMBING", '[', ']'))
            .into_iter()
            .collect(),
        "PLUMBING"
    );
    assert_eq!(
        JITO_TIP_ACCOUNTS
            .iter()
            .map(|s| s.to_string())
            .collect::<BTreeSet<_>>(),
        strings(&block(&p, "JITO_TIP_ACCOUNTS", '[', ']'))
            .into_iter()
            .collect(),
        "JITO_TIP_ACCOUNTS"
    );
    let c = src("shared/src/constants.ts");
    assert_eq!(
        NON_MEMECOIN_MINTS
            .iter()
            .map(|s| s.to_string())
            .collect::<BTreeSet<_>>(),
        strings(&block(&c, "NON_MEMECOIN_MINTS", '[', ']'))
            .into_iter()
            .collect(),
        "NON_MEMECOIN_MINTS"
    );
}
