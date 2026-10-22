//! Function bodies: calls, bindings, closures, match arms and struct literals.

use std::collections::HashMap;

#[derive(Clone, Copy)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

pub fn tally(words: &[&str]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for (index, word) in words.iter().enumerate() {
        let entry = counts.entry(word.to_string()).or_insert(0);
        *entry += index;
    }
    counts
}

pub fn classify(value: Option<i32>) -> &'static str {
    match value {
        Some(n) if n < 0 => "negative",
        Some(0) => "zero",
        Some(_) => "positive",
        None => "none",
    }
}

pub fn make_adder(step: i32) -> impl Fn(i32) -> i32 {
    move |x| x + step
}

pub fn sum_doubled(values: &[i32]) -> i32 {
    values.iter().map(|v| v * 2).sum()
}

pub fn origin(points: &[Point]) -> Point {
    let start = Point { x: 0, y: 0 };
    if let Some(first) = points.first() {
        return *first;
    }
    let Point { x, .. } = start;
    let _unused = x;
    let mut stack = vec![start];
    while let Some(top) = stack.pop() {
        if top.x > 10 {
            break;
        }
    }
    Point { y: 0, ..start }
}
