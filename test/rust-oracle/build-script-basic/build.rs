use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=assets/schema.json");
    println!("cargo::rerun-if-changed=build-input.txt");
    println!("cargo:rustc-env=BUILD_TAG=oracle");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out.join("generated.rs"), "pub fn generated() -> u32 {\n    7\n}\n").unwrap();
}
