//! Reading a secret answer from the terminal with echo off.
use std::io::IsTerminal;

/// Turns echo off on standard input until dropped.
pub struct EchoOff(libc::termios);

impl EchoOff {
    /// `None` when standard input is not a terminal or echo cannot be turned off.
    pub fn new() -> Option<Self> {
        if !std::io::stdin().is_terminal() {
            return None;
        }
        // SAFETY: termios is plain data, and tcgetattr fills it before it is read.
        let mut saved: libc::termios = unsafe { std::mem::zeroed() };
        // SAFETY: the pointer is to a live termios on this stack frame.
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut saved) } != 0 {
            return None;
        }
        let mut quiet = saved;
        quiet.c_lflag &= !libc::ECHO;
        // TCSAFLUSH drops typeahead, which the terminal has already shown.
        // SAFETY: the pointer is to a live termios on this stack frame.
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &quiet) } != 0 {
            return None;
        }
        Some(Self(saved))
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        // SAFETY: the pointer is to the termios this guard saved.
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0) };
    }
}
