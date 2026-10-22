//! Literal forms, one per token class, plus raw identifiers and comments.

pub const RAW: &str = r#"quote " inside"#;
pub const BYTES: &[u8] = b"bytes\n";
pub const BYTE: u8 = b'x';
pub const CSTR: &core::ffi::CStr = c"hello";
pub const CHAR: char = '\u{1F600}';

/* outer /* nested */ still a comment */
// line comment

pub fn literals(flag: bool) -> u64 {
    let lifetime_value: &'static str = "static";
    let big = 1_000_000u64 + 0xFF_u64 + 0o17 + 0b1010;
    let float = 1.5e-3_f64 + 2.0;
    let r#type = r#match();
    let mut total = 0;
    for n in 1..=5 {
        total += n;
    }
    if flag {
        total
    } else {
        big + r#type as u64 + float as u64 + lifetime_value.len() as u64
    }
}

fn r#match() -> u64 {
    0
}
