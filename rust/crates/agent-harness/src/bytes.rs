//! Logical byte limits shared by project compositions. The backing store still
//! needs physical space for its own framing, temporary files and atomic writes.
use agent_api::{OperationError, Result};
use serde::Serialize;
use std::io::{Result as IoResult, Write};

#[derive(Clone, Copy, Debug)]
pub struct ByteCapacity {
    pub storage: u64,
    pub control: u64,
    pub buffered: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ByteLimits {
    pub session: ByteCapacity,
    pub tenant: ByteCapacity,
    pub agent: ByteCapacity,
}

pub(crate) fn size(value: &impl Serialize) -> u64 {
    #[derive(Default)]
    struct Size(u64);
    impl Write for Size {
        fn write(&mut self, bytes: &[u8]) -> IoResult<usize> {
            self.0 = self.0.saturating_add(bytes.len() as u64);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }
    let mut size = Size::default();
    serde_json::to_writer(&mut size, value).map_or(u64::MAX, |()| size.0)
}

pub(crate) fn busy<T>() -> Result<T> {
    Err(OperationError::Busy("byte reservation exhausted".into()).into())
}
