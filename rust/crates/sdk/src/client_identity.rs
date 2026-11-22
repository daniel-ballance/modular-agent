use std::str::FromStr;

const DEFAULT_CLIENT_IDENTITY: &str = "modular-agent";

/// The client label sent as ChatGPT's originator and Grok's sign-in referrer.
/// It is not an OAuth client ID. Parse a custom label with `str::parse`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientIdentity(String);

impl ClientIdentity {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ClientIdentity {
    fn default() -> Self {
        Self(DEFAULT_CLIENT_IDENTITY.into())
    }
}

impl FromStr for ClientIdentity {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            (1..=64).contains(&value.len())
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')),
            "client identity must be 1 to 64 characters from A-Z, a-z, 0-9, '.', '_' and '-'"
        );
        Ok(Self(value.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_labels_of_the_documented_length_and_alphabet() {
        let max = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._";
        for valid in ["-", max, "My-agent_2.0"] {
            assert_eq!(valid.parse::<ClientIdentity>().unwrap().as_str(), valid);
        }
        for invalid in [
            "",
            &format!("{max}-"),
            "name with space",
            "name\né",
            "name!",
            "é",
        ] {
            assert!(invalid.parse::<ClientIdentity>().is_err(), "{invalid:?}");
        }
    }
}
