#[cfg(unix)]
pub mod platform;

#[cfg(windows)]
#[path = "platform_win.rs"]
pub mod platform;

#[cfg(test)]
mod tests;

#[cfg(all(unix, not(target_os = "macos")))]
pub mod linux {
    pub mod tuning;
}

#[cfg(any(feature = "x", target_os = "linux"))]
pub mod any_mod;
