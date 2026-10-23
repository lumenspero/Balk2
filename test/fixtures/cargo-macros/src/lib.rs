//! Macro invocations, expression-style arguments and macro-generated items (V3 Phase 10).

macro_rules! make_counter {
    () => {
        pub fn generated_counter() -> u32 {
            helper_inside_macro()
        }
    };
}

macro_rules! twice {
    ($x:expr) => {
        $x + $x
    };
}

#[macro_export]
macro_rules! exported_value {
    () => {
        42
    };
}

fn helper_inside_macro() -> u32 {
    1
}

make_counter!();

pub fn run() -> u32 {
    let a = twice!(helper_inside_macro());
    let b = crate::exported_value!();
    println!("{}", helper_inside_macro());
    a + b + generated_counter()
}
