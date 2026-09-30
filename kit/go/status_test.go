package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"testing"
)

func readStatus(t *testing.T, f string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("invalid json: %v: %s", err, b)
	}
	return m
}

func TestStatusInitPhaseFinish(t *testing.T) {
	f := filepath.Join(t.TempDir(), "status.json")
	if err := statusInit(f, "b1"); err != nil {
		t.Fatal(err)
	}
	m := readStatus(t, f)
	if m["state"] != "booting" || m["bootId"] != "b1" || m["phase"] != nil {
		t.Fatalf("bad init: %v", m)
	}
	if !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`).MatchString(m["startedAt"].(string)) {
		t.Fatalf("bad startedAt %v", m["startedAt"])
	}
	statusPhase(f, "clone", "hi \"q\"\nline2")
	statusPhase(f, "install", "")
	m = readStatus(t, f)
	if m["phase"] != "install" || len(m["history"].([]any)) != 3 {
		t.Fatalf("bad phase: %v", m)
	}
	h := m["history"].([]any)[1].(map[string]any)
	if h["phase"] != "clone" || h["message"] != "hi \"q\"\nline2" {
		t.Fatalf("bad history %v", h)
	}
	code := 3
	statusFinish(f, "failed", &code, "exit", "boom")
	m = readStatus(t, f)
	if m["state"] != "failed" || m["exitCode"] != float64(3) || m["reason"] != "exit" || m["phase"] != "install" || m["message"] != "boom" {
		t.Fatalf("bad finish: %v", m)
	}
	n := len(m["history"].([]any))
	statusPhase(f, "late", "")
	m = readStatus(t, f)
	if m["phase"] != "install" || len(m["history"].([]any)) != n {
		t.Fatalf("phase after finish not ignored: %v", m)
	}
}

func TestStatusFinishReady(t *testing.T) {
	f := filepath.Join(t.TempDir(), "s.json")
	statusInit(f, "b")
	statusFinish(f, "ready", nil, "", "")
	m := readStatus(t, f)
	if m["state"] != "ready" || m["exitCode"] != nil || m["reason"] != nil {
		t.Fatalf("%v", m)
	}
}

func TestStatusAtomic(t *testing.T) {
	f := filepath.Join(t.TempDir(), "s.json")
	statusInit(f, "b")
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			b, err := os.ReadFile(f)
			if err != nil {
				t.Errorf("read: %v", err)
				return
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Errorf("partial file: %v", err)
				return
			}
		}
	}()
	for i := 0; i < 300; i++ {
		statusPhase(f, "p", "x")
	}
	close(stop)
	wg.Wait()
}
