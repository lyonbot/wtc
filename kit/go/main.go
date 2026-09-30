// wtc-kit: static helper for wtc containers (socks, forward, status).
package main

import (
	"flag"
	"fmt"
	"net"
	"os"
)

func die(err error) {
	fmt.Fprintln(os.Stderr, "wtc-kit:", err)
	os.Exit(1)
}

func listenAndServe(addr string, serve func(net.Listener)) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		die(err)
	}
	serve(l)
}

func main() {
	if len(os.Args) < 2 {
		die(fmt.Errorf("usage: wtc-kit socks|forward|status"))
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "socks":
		fs := flag.NewFlagSet("socks", flag.ExitOnError)
		listen := fs.String("listen", "0.0.0.0:1080", "")
		user := fs.String("user", "", "")
		pass := fs.String("pass", "", "")
		fs.Parse(args)
		listenAndServe(*listen, func(l net.Listener) { serveSocks(l, *user, *pass) })
	case "forward":
		fs := flag.NewFlagSet("forward", flag.ExitOnError)
		listen := fs.String("listen", "", "")
		to := fs.String("to", "", "")
		fs.Parse(args)
		listenAndServe(*listen, func(l net.Listener) { serveForward(l, *to) })
	case "status":
		runStatus(args)
	default:
		die(fmt.Errorf("unknown command %q", cmd))
	}
}

func runStatus(args []string) {
	if len(args) < 1 {
		die(fmt.Errorf("usage: wtc-kit status init|phase|finish"))
	}
	sub := args[0]
	fs := flag.NewFlagSet("status "+sub, flag.ExitOnError)
	file := fs.String("file", "", "")
	bootID := fs.String("boot-id", "", "")
	name := fs.String("name", "", "")
	msg := fs.String("message", "", "")
	state := fs.String("state", "", "")
	reason := fs.String("reason", "", "")
	code := fs.Int("exit-code", -1, "")
	fs.Parse(args[1:])
	var err error
	switch sub {
	case "init":
		err = statusInit(*file, *bootID)
	case "phase":
		err = statusPhase(*file, *name, *msg)
	case "finish":
		var c *int
		if *code >= 0 {
			c = code
		}
		err = statusFinish(*file, *state, c, *reason, *msg)
	default:
		err = fmt.Errorf("unknown status subcommand %q", sub)
	}
	if err != nil {
		die(err)
	}
}
