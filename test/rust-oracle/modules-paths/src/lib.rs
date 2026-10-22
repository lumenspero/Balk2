#[path = "impls/first.rs"]
pub mod first;

#[path = "thread_files"]
pub mod thread {
    #[path = "tls.rs"]
    pub mod local_data;
}

pub mod parent;
