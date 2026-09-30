package main

import (
	"io"
	"net"
)

// pipe copies both directions until either side closes.
func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		io.Copy(dst, src)
		if tc, ok := dst.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}

func serveForward(l net.Listener, to string) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go func() {
			u, err := net.Dial("tcp", to)
			if err != nil {
				c.Close()
				return
			}
			pipe(c, u)
		}()
	}
}
