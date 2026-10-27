//! ISO-8601 UTC text (as stored in `wallet_swaps.ts`) to Unix milliseconds, without a date crate.

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff][Z]` (also a space instead of `T`). Returns None if malformed.
pub fn iso_to_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut ms = 0i64;
    if b.len() > 20 && b[19] == b'.' {
        let frac: String = s[20..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .take(3)
            .collect();
        if !frac.is_empty() {
            ms = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
        }
    }
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_iso() {
        assert_eq!(iso_to_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            iso_to_ms("2024-02-29T12:34:56.789Z"),
            Some(1_709_210_096_789)
        );
        assert_eq!(iso_to_ms("2024-02-29 12:34:56"), Some(1_709_210_096_000));
        assert_eq!(iso_to_ms("garbage"), None);
    }
}
