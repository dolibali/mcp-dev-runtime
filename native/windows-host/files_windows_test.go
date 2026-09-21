//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func daclFixture(t *testing.T, protected bool) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	destination, source := filepath.Join(root, "original.txt"), filepath.Join(root, "replacement.txt")
	for file, text := range map[string]string{destination: "old\r\n", source: "new\r\n"} {
		if err := os.WriteFile(file, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	control, flags := "", "ID"
	if protected {
		control, flags = "P", ""
	}
	// Deliberately omit AUTO_INHERITED: default local-machine ACLs can hide the
	// legacy inheritance conversion observed on both GitHub Windows runners.
	sd, err := windows.SecurityDescriptorFromString("D:" + control + "(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;BA)(A;" + flags + ";FA;;;" + u.User.Sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	name, _ := windows.UTF16PtrFromString(destination)
	h, err := windows.CreateFile(name, windows.READ_CONTROL|windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if err = windows.SetKernelObjectSecurity(h, windows.DACL_SECURITY_INFORMATION, sd); err != nil {
		t.Fatal(err)
	}
	before, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return source, destination, before.String()
}

func TestReplacementPreservesExactLegacyAndProtectedDACL(t *testing.T) {
	for _, protected := range []bool{false, true} {
		source, destination, before := daclFixture(t, protected)
		if err := replaceFile(source, destination); err != nil {
			t.Fatal(err)
		}
		after, err := windows.GetNamedSecurityInfo(destination, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		if after.String() != before {
			t.Fatalf("DACL changed (protected=%v): %s != %s", protected, after.String(), before)
		}
		data, err := os.ReadFile(destination)
		if err != nil || string(data) != "new\r\n" {
			t.Fatalf("content not replaced: %q %v", data, err)
		}
	}
}

func TestReplacementReportsPostCommitDACLFailure(t *testing.T) {
	source, destination, _ := daclFixture(t, true)
	err := replaceFileWithRestore(source, destination, func(windows.Handle, windows.SECURITY_INFORMATION, *windows.SECURITY_DESCRIPTOR) error {
		return errors.New("synthetic DACL restore failure")
	})
	if !errors.Is(err, errReplacementCommitted) {
		t.Fatalf("post-commit error was not identified: %v", err)
	}
	data, readErr := os.ReadFile(destination)
	if readErr != nil || string(data) != "new\r\n" {
		t.Fatalf("expected committed content: %q %v", data, readErr)
	}
}
