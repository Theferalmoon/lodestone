// SPDX-License-Identifier: Apache-2.0
// Handler functions invoked by main.go. Two top-level funcs the parser must
// emit as symbols.

package main

func handlePing() string {
	return "pong"
}

func handleVersion() string {
	return "lodestone-synthetic-demo 0.0.1"
}
