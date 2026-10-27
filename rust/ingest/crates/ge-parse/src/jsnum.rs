//! JavaScript number semantics the parser depends on, so Rust output matches Node to the byte.

/// `Number.prototype.toString()` / `JSON.stringify` for a number (NaN and ±Infinity become `null`, -0 becomes `0`).
pub fn js_number(x: f64) -> String {
    if !x.is_finite() {
        return "null".to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let mut b = ryu_js::Buffer::new();
    b.format_finite(x).to_string()
}

/// `Math.round`: the nearest integer, ties toward +Infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `10 ** d` (exact for the decimals SPL tokens use).
pub fn pow10(d: u32) -> f64 {
    const P: [f64; 23] = [
        1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
        1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
    ];
    P.get(d as usize)
        .copied()
        .unwrap_or_else(|| 10f64.powi(d as i32))
}

/// `Number(s)` for the decimal integer strings gRPC and RPC use for amounts and balances.
pub fn js_number_from_str(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// A JSON string literal, escaped like `JSON.stringify`.
pub fn js_string(s: &str) -> String {
    // Fast path: nothing to escape (base58 keys, mints, labels). Same bytes JSON.stringify prints.
    if s.bytes()
        .all(|b| b >= 0x20 && b != b'"' && b != b'\\' && b < 0x7f)
    {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        out.push_str(s);
        out.push('"');
        return out;
    }
    serde_json::to_string(s).expect("string serialises")
}

/// `new Date(ms).toISOString()` (years 0..=9999).
pub fn iso_from_ms(ms: f64) -> String {
    let ms = ms.trunc() as i64; // Date's time value is an integer
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let (h, mi, s, milli) = (
        rem / 3_600_000,
        (rem / 60_000) % 60,
        (rem / 1000) % 60,
        rem % 1000,
    );
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_print_like_js() {
        assert_eq!(js_number(1.0), "1");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.5e-7), "1.5e-7");
        assert_eq!(js_number(123456789012345680000.0), "123456789012345680000");
        assert_eq!(js_number(f64::NAN), "null");
    }
    #[test]
    fn round_like_js() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
    }
    #[test]
    fn iso_like_js() {
        assert_eq!(iso_from_ms(1_760_000_000_000.0), "2025-10-09T08:53:20.000Z");
        assert_eq!(iso_from_ms(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(951_782_400_123.0), "2000-02-29T00:00:00.123Z");
    }
}
