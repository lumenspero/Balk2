include!(concat!(env!("OUT_DIR"), "/generated.rs"));

pub fn tag() -> &'static str {
    env!("BUILD_TAG")
}
