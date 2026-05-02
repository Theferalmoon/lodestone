// SPDX-License-Identifier: Apache-2.0
// Tiny Go CLI — entrypoint that dispatches to handler.go. Verifies the §06
// Go parser sees package-level functions and call edges.

package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	switch cmd {
	case "ping":
		fmt.Println(handlePing())
	case "version":
		fmt.Println(handleVersion())
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", cmd)
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "usage: cli {ping|version}")
}
