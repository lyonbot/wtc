package main

import (
	"errors"
	"io"
	"net"
	"strconv"
)

func serveSocks(l net.Listener, user, pass string) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go func() {
			if err := handleSocks(c, user, pass); err != nil {
				c.Close()
			}
		}()
	}
}

func handleSocks(c net.Conn, user, pass string) error {
	h := make([]byte, 2)
	if _, err := io.ReadFull(c, h); err != nil || h[0] != 5 {
		return errors.New("bad greeting")
	}
	methods := make([]byte, h[1])
	if _, err := io.ReadFull(c, methods); err != nil {
		return err
	}
	want := byte(0)
	if user != "" {
		want = 2
	}
	ok := false
	for _, m := range methods {
		ok = ok || m == want
	}
	if !ok {
		c.Write([]byte{5, 0xff})
		return errors.New("no acceptable method")
	}
	c.Write([]byte{5, want})
	if want == 2 {
		if err := socksAuth(c, user, pass); err != nil {
			return err
		}
	}

	r := make([]byte, 4)
	if _, err := io.ReadFull(c, r); err != nil || r[0] != 5 {
		return errors.New("bad request")
	}
	if r[1] != 1 {
		socksReply(c, 7)
		return errors.New("only CONNECT")
	}
	var host string
	switch r[3] {
	case 1, 4:
		ip := make([]byte, map[byte]int{1: 4, 4: 16}[r[3]])
		if _, err := io.ReadFull(c, ip); err != nil {
			return err
		}
		host = net.IP(ip).String()
	case 3:
		n := make([]byte, 1)
		if _, err := io.ReadFull(c, n); err != nil {
			return err
		}
		d := make([]byte, n[0])
		if _, err := io.ReadFull(c, d); err != nil {
			return err
		}
		host = string(d)
	default:
		socksReply(c, 8)
		return errors.New("bad atyp")
	}
	p := make([]byte, 2)
	if _, err := io.ReadFull(c, p); err != nil {
		return err
	}
	target := net.JoinHostPort(host, strconv.Itoa(int(p[0])<<8|int(p[1])))
	u, err := net.Dial("tcp", target)
	if err != nil {
		socksReply(c, 5)
		return err
	}
	socksReply(c, 0)
	pipe(c, u)
	return nil
}

func socksReply(c net.Conn, code byte) {
	c.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
}

func socksAuth(c net.Conn, user, pass string) error {
	v := make([]byte, 2)
	if _, err := io.ReadFull(c, v); err != nil || v[0] != 1 {
		return errors.New("bad auth version")
	}
	u := make([]byte, v[1])
	if _, err := io.ReadFull(c, u); err != nil {
		return err
	}
	pl := make([]byte, 1)
	if _, err := io.ReadFull(c, pl); err != nil {
		return err
	}
	p := make([]byte, pl[0])
	if _, err := io.ReadFull(c, p); err != nil {
		return err
	}
	if string(u) != user || string(p) != pass {
		c.Write([]byte{1, 1})
		return errors.New("auth failed")
	}
	c.Write([]byte{1, 0})
	return nil
}
