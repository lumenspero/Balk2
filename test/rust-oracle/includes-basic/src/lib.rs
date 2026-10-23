pub mod data;

pub const PAGE: &str = include_str!("../assets/page.html");
pub const RAW: &[u8] = include_bytes!("../assets/blob.bin");

pub fn config() -> &'static str {
    include_str!("../assets/config.json")
}

include!("generated.rs");
