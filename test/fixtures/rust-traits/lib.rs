//! Traits, impls, generics and where clauses.

use std::fmt::Debug;

pub trait Container<T>: Debug
where
    T: Clone,
{
    type Item;
    const SIZE: usize;

    fn get(&self, index: usize) -> Option<&T>;

    fn first(&self) -> Option<&T> {
        self.get(0)
    }
}

impl<T: Clone + Debug> Container<T> for Vec<T> {
    type Item = T;
    const SIZE: usize = 0;

    fn get(&self, index: usize) -> Option<&T> {
        <[T]>::get(self, index)
    }
}

pub struct Stack {
    items: Vec<u8>,
}

impl Default for Stack {
    fn default() -> Self {
        Stack { items: Vec::new() }
    }
}

pub unsafe trait Marker {}

unsafe impl Marker for Stack {}

pub fn largest<'a, T: PartialOrd>(items: &'a [T]) -> &'a T {
    let mut best = &items[0];
    for item in items {
        if item > best {
            best = item;
        }
    }
    best
}
