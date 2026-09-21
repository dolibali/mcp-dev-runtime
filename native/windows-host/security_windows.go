//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func userSID() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return u.User.Sid, nil
}
func descriptor() (*windows.SECURITY_DESCRIPTOR, error) {
	sid, err := userSID()
	if err != nil {
		return nil, err
	}
	return windows.SecurityDescriptorFromString("O:" + sid.String() + "D:P(A;OICI;FA;;;" + sid.String() + ")(A;OICI;FA;;;SY)")
}
func validatePrivate(p string) error {
	info, err := os.Lstat(p)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("private paths must not be reparse points")
	}
	name, err := windows.UTF16PtrFromString(longPath(p))
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(name, windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var fi windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(h, &fi); err != nil {
		return err
	}
	if fi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return errors.New("private paths must not be reparse points")
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	sid, err := userSID()
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if owner == nil || (owner.String() != sid.String() && owner.String() != "S-1-5-32-544") {
		return errors.New("private path owner is not the current user/administrators")
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if acl == nil {
		return errors.New("private path has no restricting DACL")
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err = windows.GetAce(acl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE {
			a := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			if a != sid.String() && a != "S-1-5-18" && a != "S-1-5-32-544" {
				return errors.New("private path grants access to another user/group; no permissions were modified")
			}
		} else if ace.Header.AceType != windows.ACCESS_DENIED_ACE_TYPE {
			return errors.New("unsupported private-path access rule")
		}
	}
	return nil
}
func securityCommand(op, p string) error {
	if strings.ContainsAny(p, "\x00\r\n") {
		return errors.New("invalid private path")
	}
	if op == "pipe-acl" {
		if !strings.HasPrefix(p, `\\.\pipe\mdr-`) {
			return errors.New("not an MDR control pipe")
		}
		sd, err := descriptor()
		if err != nil {
			return err
		}
		dacl, _, err := sd.DACL()
		if err != nil {
			return err
		}
		return windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
	}
	if !filepath.IsAbs(p) {
		return errors.New("private path must be absolute")
	}
	if err := rejectReparseAncestors(p); err != nil {
		return err
	}
	if op == "private-file" {
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			sd, err := descriptor()
			if err != nil {
				return err
			}
			sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
			wide, err := windows.UTF16PtrFromString(longPath(p))
			if err != nil {
				return err
			}
			h, err := windows.CreateFile(wide, windows.GENERIC_WRITE, 0, sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
			if err != nil {
				return err
			}
			windows.CloseHandle(h)
		}
	}
	if op == "private-dir" {
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			parent := filepath.Dir(p)
			if _, err := os.Stat(parent); os.IsNotExist(err) {
				if err = securityCommand("private-dir", parent); err != nil {
					return err
				}
			}
			sd, err := descriptor()
			if err != nil {
				return err
			}
			sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
			wide, err := windows.UTF16PtrFromString(longPath(p))
			if err != nil {
				return err
			}
			if err = windows.CreateDirectory(wide, sa); err != nil && err != windows.ERROR_ALREADY_EXISTS {
				return err
			}
		}
	}
	if err := validatePrivate(p); err != nil {
		return err
	}
	return nil
}
func identityCommand(args []string) error {
	pid := uint32(os.Getpid())
	if len(args) > 0 {
		n, e := strconv.ParseUint(args[0], 10, 32)
		if e != nil {
			return e
		}
		pid = uint32(n)
	}
	sid, err := userSID()
	if err != nil {
		return err
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var created, exited, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"pid": pid, "sid": sid.String(), "created": fmt.Sprintf("%08x%08x", created.HighDateTime, created.LowDateTime), "elevated": windows.GetCurrentProcessToken().IsElevated()})
}
func launchDetached(r request, log *os.File) error {
	c := exec.Command(r.Exe, r.Args...)
	c.Dir = r.Cwd
	c.Stdout = log
	c.Stderr = log
	for k, v := range r.Env {
		c.Env = append(c.Env, k+"="+v)
	}
	// DETACHED_PROCESS is not a service installation and never asks for elevation.
	c.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_BREAKAWAY_FROM_JOB, HideWindow: true}
	if err := c.Start(); err != nil {
		return fmt.Errorf("detached launch denied by host policy: %w", err)
	}
	pid := c.Process.Pid
	if err := c.Process.Release(); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"pid": pid})
}
