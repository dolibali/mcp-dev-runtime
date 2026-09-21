//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// A native launcher preserves argv (quotes, Unicode, %, !, &), without cmd.exe
// re-parsing. It also avoids requiring developer-mode symlink privileges.
func commandEntry(args []string) int {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 125
	}
	dir := filepath.Dir(self)
	data, err := os.ReadFile(filepath.Join(dir, "mdr-command.json"))
	var m struct {
		Project string `json:"project"`
		Schema  int    `json:"schema_version"`
		Kind    string `json:"kind"`
		Root    string `json:"root"`
		Node    string `json:"node"`
		Prefix  string `json:"prefix"`
	}
	if err == nil {
		err = json.Unmarshal(data, &m)
	}
	if err != nil || m.Project != "mcp-dev-runtime" || m.Schema != 1 {
		fmt.Fprintln(os.Stderr, "Invalid MDR command registration; reinstall this command.")
		return 125
	}
	node, app := m.Node, m.Root
	switch m.Kind {
	case "source":
		if !filepath.IsAbs(node) || !filepath.IsAbs(app) {
			err = errors.New("invalid source entry")
		}
	case "binary":
		var pointer struct {
			Version string `json:"version"`
			Project string `json:"project"`
		}
		var p []byte
		if !filepath.IsAbs(m.Prefix) {
			err = errors.New("invalid installation prefix")
			break
		}
		p, err = os.ReadFile(filepath.Join(m.Prefix, "current.json"))
		if err == nil {
			err = json.Unmarshal(p, &pointer)
		}
		if err != nil || pointer.Project != "mcp-dev-runtime" || !regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$`).MatchString(pointer.Version) {
			err = errors.New("invalid installed version pointer")
			break
		}
		app = filepath.Join(m.Prefix, pointer.Version, "app")
		node = filepath.Join(m.Prefix, pointer.Version, "runtime", "node.exe")
	case "portable":
		app = filepath.Join(dir, "..", "app")
		node = filepath.Join(dir, "..", "runtime", "node.exe")
	default:
		err = errors.New("unknown command registration kind")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 125
	}
	c := exec.Command(node, append([]string{filepath.Join(app, "dist", "launcher", "cli.js")}, args...)...)
	c.Stdin = os.Stdin
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	if err = c.Run(); err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			return e.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
		return 125
	}
	return 0
}

func isCommandEntry() bool {
	name := strings.ToLower(filepath.Base(os.Args[0]))
	return name == "mdr.exe" || name == "mcp-dev-runtime.exe"
}
