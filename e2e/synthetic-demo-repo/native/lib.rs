// SPDX-License-Identifier: Apache-2.0
// Synthetic Rust crate. Defines a NativeError type with `impl Display` so
// the §06 Rust parser emits at least one class_inheritance triple
// (NativeError implements Display) — exercising the trait-impl edge.

use std::fmt;

pub struct NativeError {
    pub message: String,
}

impl NativeError {
    pub fn new(message: &str) -> NativeError {
        NativeError {
            message: message.to_string(),
        }
    }
}

impl fmt::Display for NativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NativeError: {}", self.message)
    }
}

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn greet(name: &str) -> String {
    format!("hello, {}", name)
}
