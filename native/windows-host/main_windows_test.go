//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"strings"
	"testing"
)

func TestEnvironmentRejectsAmbiguousKeys(t *testing.T) {
	for _, env := range []map[string]string{{"PATH": "one", "Path": "two"}, {"bad=name": "x"}, {"x": "bad\x00value"}} {
		if _, err := environment(env); err == nil {
			t.Fatal("unsafe environment accepted")
		}
	}
	data, err := environment(map[string]string{"PATH": "C:\\Windows", "UNICODE": "中文🙂"})
	if err != nil || len(data) < 2 || data[len(data)-1] != 0 || data[len(data)-2] != 0 {
		t.Fatal("invalid Windows environment block", err)
	}
}

func TestStartRequestRequiresOwnedProtocolAndAbsolutePaths(t *testing.T) {
	valid := request{Protocol: protocol, Type: "start", Exe: `C:\Windows\System32\cmd.exe`, Cwd: `C:\work`, Args: []string{"/c", "echo ok"}}
	check := func(r request) error {
		b, _ := json.Marshal(r)
		_, err := decodeStart(bufio.NewScanner(strings.NewReader(string(b) + "\n")))
		return err
	}
	if err := check(valid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*request){func(r *request) { r.Protocol++ }, func(r *request) { r.Exe = "relative.exe" }, func(r *request) { r.Exe = `C:\test.cmd` }, func(r *request) { r.Cwd = "C:relative" }, func(r *request) { r.Args = []string{"bad\x00argument"} }} {
		r := valid
		change(&r)
		if check(r) == nil {
			t.Fatal("invalid request accepted")
		}
	}
}
