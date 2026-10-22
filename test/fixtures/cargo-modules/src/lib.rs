mod util;

#[cfg(unix)]
mod platform;

#[cfg(windows)]
#[path = "platform_win.rs"]
mod platform;

#[cfg(all(unix, not(target_os = "macos")))]
mod linux {
    mod tuning;
}

#[path = "gen/generated.rs"]
mod generated;

mod missing;
