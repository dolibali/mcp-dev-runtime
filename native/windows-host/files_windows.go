//go:build windows

package main

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"unsafe"
)

func longPath(p string) string {
	if strings.HasPrefix(p, `\\?\`) || strings.HasPrefix(p, `\\.\`) {
		return p
	}
	if strings.HasPrefix(p, `\\`) {
		return `\\?\UNC\` + p[2:]
	}
	return `\\?\` + p
}

// ReplaceFile can normalize legacy inherited ACEs into explicit entries and
// inherit the parent's ACL again. Preserve the exact original DACL, including
// its inheritance control bits, through a replacement handle opened beforehand.
// A post-replacement failure must be reported as a partial file change.
var errReplacementCommitted = errors.New("WINDOWS_REPLACEMENT_COMMITTED")

func replaceFile(source, destination string) error {
	return replaceFileWithRestore(source, destination, windows.SetKernelObjectSecurity)
}

// The restore argument supports deterministic native fault tests only; no
// command-line switch or environment variable can substitute this operation.
func replaceFileWithRestore(source, destination string, restore func(windows.Handle, windows.SECURITY_INFORMATION, *windows.SECURITY_DESCRIPTOR) error) error {
	for _, p := range []string{source, destination} {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n") {
			return errors.New("absolute regular-file paths required")
		}
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("replacement target must not be a reparse point")
		}
	}
	s, err := windows.UTF16PtrFromString(longPath(source))
	if err != nil {
		return err
	}
	d, err := windows.UTF16PtrFromString(longPath(destination))
	if err != nil {
		return err
	}
	original, err := windows.GetNamedSecurityInfo(longPath(destination), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read destination DACL before replacement: %w", err)
	}
	if original == nil {
		return errors.New("destination has no readable security descriptor")
	}
	// A read descriptor omits the set-only AUTO_INHERIT_REQ bit. When copying an
	// already AUTO_INHERITED DACL through the low-level descriptor API, include
	// that request bit or Windows clears AUTO_INHERITED as legacy compatibility.
	// Work on a copy so verification still compares against the original flags.
	writable, err := original.ToAbsolute()
	if err != nil {
		return fmt.Errorf("prepare saved DACL: %w", err)
	}
	control, _, err := original.Control()
	if err != nil {
		return err
	}
	var request windows.SECURITY_DESCRIPTOR_CONTROL
	if control&windows.SE_DACL_AUTO_INHERITED != 0 {
		request = windows.SE_DACL_AUTO_INHERIT_REQ
	}
	if err = writable.SetControl(windows.SE_DACL_AUTO_INHERIT_REQ, request); err != nil {
		return err
	}
	// Hold WRITE_DAC before commit, even when the merged descriptor later denies
	// reopening the file. No ACL error is ignored; restore the saved DACL exactly.
	h, err := windows.CreateFile(s, windows.READ_CONTROL|windows.WRITE_DAC, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return fmt.Errorf("open replacement DACL handle: %w", err)
	}
	defer windows.CloseHandle(h)
	result, _, callErr := windows.NewLazySystemDLL("kernel32.dll").NewProc("ReplaceFileW").Call(uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(s)), 0, 0, 0, 0)
	if result == 0 {
		return callErr
	}
	if err = restore(h, windows.DACL_SECURITY_INFORMATION, writable); err != nil {
		return fmt.Errorf("%w: content changed but exact DACL restoration failed: %v", errReplacementCommitted, err)
	}
	// Read back using the same named-file API used for the snapshot. On Windows
	// Server, named and open-handle queries can serialize inherited ACL state
	// differently even though a fresh named-file query exactly matches the saved
	// descriptor. Do not compare results from those different query paths.
	after, err := windows.GetNamedSecurityInfo(longPath(destination), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil || after == nil || after.String() != original.String() {
		return fmt.Errorf("%w: content changed but exact DACL verification failed", errReplacementCommitted)
	}
	return nil
}

func rejectReparseAncestors(p string) error {
	for current := filepath.Clean(p); ; current = filepath.Dir(current) {
		wide, err := windows.UTF16PtrFromString(longPath(current))
		if err != nil {
			return err
		}
		attrs, err := windows.GetFileAttributes(wide)
		if err == nil && attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("private paths may not traverse a reparse point")
		}
		if err != nil && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return err
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	return nil
}
