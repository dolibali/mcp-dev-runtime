//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func daclFixture(t *testing.T, protected bool, inherited bool) (string, string, string) {
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
	if inherited {
		control += "AI"
	}
	// Cover both legacy and modern inheritance; default local ACLs alone can
	// hide the conversion observed on GitHub's Windows runners.
	sd, err := windows.SecurityDescriptorFromString("D:" + control + "(A;" + flags + ";FA;;;SY)(A;" + flags + ";FA;;;BA)(A;" + flags + ";FA;;;" + u.User.Sid.String() + ")")
	if err != nil {
		t.Fatal(err)
	}
	if inherited {
		if err = sd.SetControl(windows.SE_DACL_AUTO_INHERIT_REQ, windows.SE_DACL_AUTO_INHERIT_REQ); err != nil {
			t.Fatal(err)
		}
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
		for _, inherited := range []bool{false, true} {
			source, destination, before := daclFixture(t, protected, inherited)
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
}

func TestReplacementReportsPostCommitDACLFailure(t *testing.T) {
	source, destination, _ := daclFixture(t, true, false)
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

func TestReplacementPreservesDefaultFileDACL(t *testing.T) {
	root := t.TempDir()
	source, destination := filepath.Join(root, "replacement.txt"), filepath.Join(root, "default.txt")
	for file, text := range map[string]string{source: "new", destination: "old"} {
		if err := os.WriteFile(file, []byte(text), 0666); err != nil {
			t.Fatal(err)
		}
	}
	const fields = windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION
	before, err := windows.GetNamedSecurityInfo(destination, windows.SE_FILE_OBJECT, fields)
	if err != nil {
		t.Fatal(err)
	}
	daclBefore, err := windows.GetNamedSecurityInfo(longPath(destination), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	var supplied string
	replaceErr := replaceFileWithRestore(source, destination, func(h windows.Handle, flags windows.SECURITY_INFORMATION, sd *windows.SECURITY_DESCRIPTOR) error {
		supplied = sd.String()
		return windows.SetKernelObjectSecurity(h, flags, sd)
	})
	after, err := windows.GetNamedSecurityInfo(destination, windows.SE_FILE_OBJECT, fields)
	if err != nil {
		t.Fatal(err)
	}
	if replaceErr != nil || before.String() != after.String() {
		oldControl, _, _ := before.Control()
		newControl, _, _ := after.Control()
		daclAfter, queryErr := windows.GetNamedSecurityInfo(longPath(destination), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		t.Fatalf("default fixture DACL changed: error=%v, controls=%x/%x, before=%s, after=%s, dacl-only-before=%s, supplied=%s, dacl-only-after=%v, query-error=%v", replaceErr, oldControl, newControl, before.String(), after.String(), daclBefore.String(), supplied, daclAfter, queryErr)
	}
}
