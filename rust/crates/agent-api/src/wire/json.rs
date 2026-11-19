//! Validation that runs on the received JSON, before projection into a Value.
use serde::de::{DeserializeSeed, Error, MapAccess, SeqAccess, Visitor};
use std::{collections::BTreeSet, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonError {
    Invalid,
    TooDeep,
}
impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => f.write_str("invalid JSON"),
            Self::TooDeep => f.write_str("JSON nesting exceeds the supported depth"),
        }
    }
}
impl std::error::Error for JsonError {}

struct Check;
impl<'de> DeserializeSeed<'de> for Check {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Check {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON without duplicate members")
    }
    fn visit_unit<E: Error>(self) -> Result<(), E> {
        Ok(())
    }
    fn visit_bool<E: Error>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E: Error>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E: Error>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E: Error>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E: Error>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while seq.next_element_seed(Check)?.is_some() {}
        Ok(())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        let mut names = BTreeSet::new();
        while let Some(name) = map.next_key::<String>()? {
            if !names.insert(name) {
                return Err(A::Error::custom("duplicate JSON member"));
            }
            map.next_value_seed(Check)?;
        }
        Ok(())
    }
}

pub fn decode_json(bytes: &[u8]) -> Result<serde_json::Value, JsonError> {
    // Count only brackets outside strings. Validate syntax separately so number
    // handling inside serde_json does not add to the shared wire depth.
    let (mut depth, mut string, mut escaped) = (0_usize, false, false);
    for &byte in bytes {
        if string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                string = false;
            }
        } else {
            match byte {
                b'"' => string = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > 64 {
                        return Err(JsonError::TooDeep);
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    Check
        .deserialize(&mut deserializer)
        .map_err(|_| JsonError::Invalid)?;
    deserializer.end().map_err(|_| JsonError::Invalid)?;
    serde_json::from_slice(bytes).map_err(|_| JsonError::Invalid)
}

pub fn json_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    match (a, b) {
        (Number(a), Number(b)) => number_eq(a, b),
        (Array(a), Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| json_eq(x, y)),
        (Object(a), Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, x)| b.get(k).is_some_and(|y| json_eq(x, y)))
        }
        _ => a == b,
    }
}

pub fn number_eq(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    a == b || equal_decimal(&a.to_string(), &b.to_string())
}

fn equal_decimal(a: &str, b: &str) -> bool {
    let (negative_a, digits_a, exponent_a, offset_a) = decimal(a);
    let (negative_b, digits_b, exponent_b, offset_b) = decimal(b);
    negative_a == negative_b
        && digits_a == digits_b
        && (digits_a.is_empty() || equal_scale(exponent_a, exponent_b, offset_b - offset_a))
}

/// Sign, significant digits, and scale (the written exponent plus an offset).
/// Comparing the original digits avoids rounding different numbers together.
fn decimal(number: &str) -> (bool, String, &str, i128) {
    let (negative, unsigned) = match number.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, number),
    };
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{whole}{fraction}");
    let significant = digits.trim_matches('0');
    if significant.is_empty() {
        return (false, String::new(), "0", 0);
    }
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    (
        negative,
        significant.to_owned(),
        exponent,
        trailing as i128 - fraction.len() as i128,
    )
}

fn exponent_digits(exponent: &str) -> impl Iterator<Item = i128> + '_ {
    let sign = if exponent.starts_with('-') { -1 } else { 1 };
    exponent
        .trim_start_matches(['+', '-'])
        .bytes()
        .rev()
        .map(move |digit| sign * i128::from(digit - b'0'))
}

fn equal_scale(a: &str, b: &str, mut difference: i128) -> bool {
    // Subtract the expected difference one digit at a time, so even a very
    // large written exponent does not need to fit in a machine integer.
    let (mut a, mut b) = (exponent_digits(a), exponent_digits(b));
    loop {
        match (a.next(), b.next()) {
            (None, None) => return difference == 0,
            (a, b) => {
                difference -= a.unwrap_or(0) - b.unwrap_or(0);
                if difference % 10 != 0 {
                    return false;
                }
                difference /= 10;
            }
        }
    }
}

/// Only copy fields that changed between the two native projections. A
/// single-entry projection cannot fill in fields that depend on the rest of
/// the session, such as the turn's step count.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_json_counts_objects_and_arrays_and_rejects_duplicate_names() {
        let nested = |n: usize| {
            format!(
                "{}123456789012345678901234567890.01{}",
                "[".repeat(n),
                "]".repeat(n)
            )
        };
        assert!(decode_json(nested(64).as_bytes()).is_ok());
        assert_eq!(decode_json(nested(65).as_bytes()), Err(JsonError::TooDeep));
        assert!(decode_json(br#"{"obj":{"name":1,"na\u006de":2}}"#).is_err());
        assert!(decode_json(br#""\ud800""#).is_err());
        assert!(decode_json(br#"{"notdepth":"[\"{[]}"}"#).is_ok());
    }
}
