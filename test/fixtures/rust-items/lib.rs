//! Item forms: modules, use trees, declarations and extern items.
#![allow(dead_code)]

extern crate core;
use std::collections::{BTreeMap as Tree, HashMap};
use std::fmt::{self, Display};
pub use crate::inner::*;

mod inner {
    pub const LIMIT: usize = 10;
    pub static NAME: &str = "items";
    pub type Pair<T> = (T, T);

    /// A point.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Point {
        pub x: i32,
        pub(crate) y: i32,
    }

    pub struct Unit;

    pub struct Wrapper<'a>(pub u8, &'a str);

    pub enum Shape {
        Circle { radius: f64 },
        Square(f64),
        Empty,
    }

    pub union Bits {
        pub as_u: u32,
        pub as_f: f32,
    }

    pub fn pair<T: Clone>(value: T) -> Pair<T>
    where
        T: Clone,
    {
        (value.clone(), value)
    }
}

extern "C" {
    fn abs(input: i32) -> i32;
}
