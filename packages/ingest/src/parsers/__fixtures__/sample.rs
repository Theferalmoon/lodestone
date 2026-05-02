use std::io;

pub struct S {
	pub x: i32,
}

pub trait T {
	fn t(&self) -> i32;
}

impl T for S {
	fn t(&self) -> i32 {
		self.x
	}
}

pub fn f() -> i32 {
	let s = S { x: 1 };
	s.t()
}

#[allow(dead_code)]
fn _unused() {
	let _ = io::stdin();
}
