package main

import (
	"io"
	"net"
	"strconv"
	"testing"
)

func echoServer(t *testing.T) (net.Listener, int) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.Copy(c, c) }()
		}
	}()
	return l, l.Addr().(*net.TCPAddr).Port
}

func socksServer(t *testing.T, user, pass string) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go serveSocks(l, user, pass)
	return l.Addr().String()
}

func readFull(t *testing.T, c net.Conn, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := io.ReadFull(c, b); err != nil {
		t.Fatalf("read %d: %v", n, err)
	}
	return b
}

func connectReq(atyp byte, addr []byte, port int) []byte {
	r := append([]byte{5, 1, 0, atyp}, addr...)
	return append(r, byte(port>>8), byte(port))
}

func echoCheck(t *testing.T, c net.Conn) {
	t.Helper()
	c.Write([]byte("hello"))
	if got := string(readFull(t, c, 5)); got != "hello" {
		t.Fatalf("echo got %q", got)
	}
}

func TestSocksNoAuthIPv4(t *testing.T) {
	_, port := echoServer(t)
	c, _ := net.Dial("tcp", socksServer(t, "", ""))
	defer c.Close()
	c.Write([]byte{5, 1, 0})
	if r := readFull(t, c, 2); r[0] != 5 || r[1] != 0 {
		t.Fatalf("method %v", r)
	}
	c.Write(connectReq(1, []byte{127, 0, 0, 1}, port))
	if r := readFull(t, c, 10); r[1] != 0 {
		t.Fatalf("reply %v", r)
	}
	echoCheck(t, c)
}

func TestSocksDomain(t *testing.T) {
	_, port := echoServer(t)
	c, _ := net.Dial("tcp", socksServer(t, "", ""))
	defer c.Close()
	c.Write([]byte{5, 1, 0})
	readFull(t, c, 2)
	c.Write(connectReq(3, append([]byte{9}, "localhost"...), port))
	if r := readFull(t, c, 10); r[1] != 0 {
		t.Fatalf("reply %v", r)
	}
	echoCheck(t, c)
}

func TestSocksIPv6(t *testing.T) {
	l, err := net.Listen("tcp", "[::1]:0")
	if err != nil {
		t.Skip("no ipv6")
	}
	defer l.Close()
	go func() {
		c, _ := l.Accept()
		if c != nil {
			io.Copy(c, c)
		}
	}()
	port, _ := strconv.Atoi(strconv.Itoa(l.Addr().(*net.TCPAddr).Port))
	c, _ := net.Dial("tcp", socksServer(t, "", ""))
	defer c.Close()
	c.Write([]byte{5, 1, 0})
	readFull(t, c, 2)
	c.Write(connectReq(4, net.IPv6loopback, port))
	if r := readFull(t, c, 10); r[1] != 0 {
		t.Fatalf("reply %v", r)
	}
	echoCheck(t, c)
}

func authReq(u, p string) []byte {
	r := []byte{1, byte(len(u))}
	r = append(r, u...)
	r = append(r, byte(len(p)))
	return append(r, p...)
}

func TestSocksAuth(t *testing.T) {
	_, port := echoServer(t)
	addr := socksServer(t, "bob", "pw")

	c, _ := net.Dial("tcp", addr)
	c.Write([]byte{5, 2, 0, 2})
	if r := readFull(t, c, 2); r[1] != 2 {
		t.Fatalf("expected method 2, got %v", r)
	}
	c.Write(authReq("bob", "pw"))
	if r := readFull(t, c, 2); r[1] != 0 {
		t.Fatalf("auth %v", r)
	}
	c.Write(connectReq(1, []byte{127, 0, 0, 1}, port))
	readFull(t, c, 10)
	echoCheck(t, c)
	c.Close()

	c, _ = net.Dial("tcp", addr)
	c.Write([]byte{5, 1, 2})
	readFull(t, c, 2)
	c.Write(authReq("bob", "bad"))
	if r := readFull(t, c, 2); r[1] == 0 {
		t.Fatalf("wrong password accepted")
	}
	c.Close()

	c, _ = net.Dial("tcp", addr)
	c.Write([]byte{5, 1, 0})
	if r := readFull(t, c, 2); r[1] != 0xff {
		t.Fatalf("no-auth should be rejected: %v", r)
	}
	c.Close()
}

func TestForward(t *testing.T) {
	_, port := echoServer(t)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	go serveForward(l, "127.0.0.1:"+strconv.Itoa(port))
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	echoCheck(t, c)
}
