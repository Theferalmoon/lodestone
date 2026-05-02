package main

import (
	"fmt"
	"strings"
)

type R struct {
	name string
}

type Greeter interface {
	Greet() string
}

func F() {
	fmt.Println("hi")
}

func (r *R) M() string {
	return strings.ToUpper(r.name)
}
