//go:build windows

package main

import (
	"errors"
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

// ReplaceFile preserves the destination DACL. A delete+rename fallback would
// silently discard explicit access rules, so failures are reported to the caller.
func replaceFile(source, destination string) error {
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
	result, _, callErr := windows.NewLazySystemDLL("kernel32.dll").NewProc("ReplaceFileW").Call(uintptr(unsafe.Pointer(d)), uintptr(unsafe.Pointer(s)), 0, 0, 0, 0)
	if result == 0 {
		return callErr
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
