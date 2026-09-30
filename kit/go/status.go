package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

type histEntry struct {
	At      string `json:"at"`
	State   string `json:"state"`
	Phase   string `json:"phase,omitempty"`
	Message string `json:"message,omitempty"`
}

// status is the on-disk protocol read by the host (spec §7).
type status struct {
	BootID    string      `json:"bootId"`
	StartedAt string      `json:"startedAt"`
	State     string      `json:"state"`
	Phase     *string     `json:"phase"`
	Message   string      `json:"message,omitempty"`
	ExitCode  *int        `json:"exitCode,omitempty"`
	Reason    string      `json:"reason,omitempty"`
	History   []histEntry `json:"history"`
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func writeStatus(f string, s *status) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.tmp.%d", f, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f)
}

func readStatusFile(f string) (*status, error) {
	b, err := os.ReadFile(f)
	if err != nil {
		return nil, err
	}
	s := &status{}
	return s, json.Unmarshal(b, s)
}

func statusInit(f, bootID string) error {
	now := nowISO()
	return writeStatus(f, &status{BootID: bootID, StartedAt: now, State: "booting",
		History: []histEntry{{At: now, State: "booting"}}})
}

// statusPhase is a no-op unless the state is still "booting".
func statusPhase(f, name, msg string) error {
	fmt.Printf("[wtc] phase %s %s\n", name, msg)
	s, err := readStatusFile(f)
	if err != nil {
		return err
	}
	if s.State != "booting" {
		return nil
	}
	s.Phase = &name
	s.History = append(s.History, histEntry{At: nowISO(), State: "booting", Phase: name, Message: msg})
	return writeStatus(f, s)
}

func statusFinish(f, state string, exitCode *int, reason, msg string) error {
	if state != "ready" && state != "failed" {
		return fmt.Errorf("invalid --state %q (want ready|failed)", state)
	}
	s, err := readStatusFile(f)
	if err != nil {
		return err
	}
	s.State, s.ExitCode, s.Reason, s.Message = state, exitCode, reason, msg
	h := histEntry{At: nowISO(), State: state, Message: msg}
	if s.Phase != nil {
		h.Phase = *s.Phase
	}
	s.History = append(s.History, h)
	return writeStatus(f, s)
}
