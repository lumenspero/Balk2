//! Macros, extern blocks and function qualifiers.

#[macro_export]
macro_rules! square {
    ($x:expr) => {
        $x * $x
    };
}

thread_local! {
    static COUNTER: std::cell::Cell<u32> = std::cell::Cell::new(0);
}

extern "C" {
    fn abs(input: i32) -> i32;
}

pub unsafe extern "C" fn callback(value: i32) -> i32 {
    value
}

const fn double(x: u32) -> u32 {
    x * 2
}

async fn fetch(url: &str) -> Result<String, ()> {
    Ok(url.to_string())
}

pub fn use_macros() -> i32 {
    let total = square!(3) + unsafe { abs(-4) };
    println!("total {}", total);
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_works() {
        assert_eq!(square!(2), 4);
    }
}
