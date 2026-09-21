//go:build windows

// windows-host is an internal OS adapter, not an agent or a privileged service.
// A fresh process owns each execution's Job Object. Closing its last handle,
// including on a host crash, terminates descendants rather than leaking them.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const protocol = 1
const maxRequest = 16 * 1024 * 1024

type request struct {
	Protocol int               `json:"protocol"`
	Type     string            `json:"type"`
	Exe      string            `json:"exe"`
	Args     []string          `json:"args"`
	Cwd      string            `json:"cwd"`
	Env      map[string]string `json:"env"`
	TTY      bool              `json:"tty"`
	Stdin    bool              `json:"stdin"`
	Data     []byte            `json:"data"`
	Force    bool              `json:"force"`
	Log      string            `json:"log"`
}

type emitter struct{ sync.Mutex }

func (e *emitter) send(value any) {
	e.Lock()
	defer e.Unlock()
	// Broken parent transport means this adapter must not keep children alive.
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		os.Exit(125)
	}
}

func main() {
	if isCommandEntry() {
		os.Exit(commandEntry(os.Args[1:]))
	}
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Internal Windows host: use the MDR CLI.")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "--version":
		fmt.Printf("mdr-windows-host protocol=%d\n", protocol)
	case "run":
		err = run()
	case "private-dir", "private-file", "validate-private", "pipe-acl":
		if len(os.Args) != 3 {
			err = errors.New("one absolute path is required")
		} else {
			err = securityCommand(os.Args[1], os.Args[2])
		}
	case "identity":
		err = identityCommand(os.Args[2:])
	case "replace-file":
		if len(os.Args) != 4 {
			err = errors.New("replace-file requires source and destination")
		} else {
			err = replaceFile(os.Args[2], os.Args[3])
		}
	case "detach":
		err = detachedCommand()
	default:
		err = errors.New("unknown internal Windows operation")
	}
	if err != nil {
		// Never print requests: they can contain commands, user code and credentials.
		fmt.Fprintln(os.Stderr, "mdr-windows-host:", err)
		os.Exit(125)
	}
}

func decodeStart(scanner *bufio.Scanner) (request, error) {
	var r request
	if !scanner.Scan() {
		return r, errors.New("missing Windows start request")
	}
	if err := json.Unmarshal(scanner.Bytes(), &r); err != nil {
		return r, errors.New("invalid Windows request")
	}
	if r.Protocol != protocol || r.Type != "start" || !filepath.IsAbs(r.Exe) || !filepath.IsAbs(r.Cwd) ||
		strings.ContainsAny(r.Exe+r.Cwd, "\x00\r\n") || !strings.EqualFold(filepath.Ext(r.Exe), ".exe") {
		return r, errors.New("invalid protocol or absolute executable/workspace")
	}
	for _, a := range r.Args {
		if strings.ContainsRune(a, 0) {
			return r, errors.New("NUL in process arguments")
		}
	}
	return r, nil
}

func environment(values map[string]string) ([]uint16, error) {
	keys := make([]string, 0, len(values))
	seen := make(map[string]bool)
	for key, value := range values {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return nil, errors.New("invalid child environment")
		}
		fold := strings.ToUpper(key)
		if seen[fold] {
			return nil, errors.New("ambiguous case-insensitive environment key")
		}
		seen[fold] = true
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return strings.ToUpper(keys[i]) < strings.ToUpper(keys[j]) })
	var block []uint16
	for _, key := range keys {
		text, err := windows.UTF16FromString(key + "=" + values[key])
		if err != nil {
			return nil, err
		}
		block = append(block, text...)
	}
	block = append(block, 0)
	if len(block) == 1 {
		block = append(block, 0)
	}
	return block, nil
}

func run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), maxRequest)
	r, err := decodeStart(scanner)
	if err != nil {
		return err
	}
	e := &emitter{}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return err
	}

	si := windows.StartupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(si))
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return err
	}
	defer attrs.Delete()
	si.ProcThreadAttributeList = attrs.List()
	flags := uint32(windows.CREATE_SUSPENDED | windows.CREATE_UNICODE_ENVIRONMENT | windows.EXTENDED_STARTUPINFO_PRESENT)
	var console windows.Handle
	var input *os.File
	var outputs []*os.File
	var childHandles []windows.Handle
	defer func() {
		for _, f := range outputs {
			f.Close()
		}
		if input != nil {
			input.Close()
		}
		for _, h := range childHandles {
			windows.CloseHandle(h)
		}
	}()
	if r.TTY {
		// Explicit NULL standard handles let ConPTY supply its console handles.
		// Without STARTF_USESTDHANDLES, Windows can copy the host's JSON pipes
		// into the shell even when general handle inheritance is disabled.
		si.Flags |= windows.STARTF_USESTDHANDLES
		var inRead, inWrite, outRead, outWrite windows.Handle
		if err = windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
			return err
		}
		if err = windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
			windows.CloseHandle(inRead)
			windows.CloseHandle(inWrite)
			return err
		}
		input = os.NewFile(uintptr(inWrite), "pty-input")
		outputs = append(outputs, os.NewFile(uintptr(outRead), "pty-output"))
		err = windows.CreatePseudoConsole(windows.Coord{X: 120, Y: 40}, inRead, outWrite, 0, &console)
		// Keep the console-side handles until CreateProcess completes, then drop
		// our copies so reader EOF correctly follows pseudoconsole teardown.
		childHandles = append(childHandles, inRead, outWrite)
		if err != nil {
			return fmt.Errorf("ConPTY creation: %w", err)
		}
		// PSEUDOCONSOLE takes the handle VALUE, not the address of the handle.
		if err = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, unsafe.Pointer(console), unsafe.Sizeof(console)); err != nil {
			windows.ClosePseudoConsole(console)
			return err
		}
	} else {
		flags |= windows.CREATE_NO_WINDOW
		sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
		var stdin windows.Handle
		if r.Stdin {
			var wr windows.Handle
			if err = windows.CreatePipe(&stdin, &wr, sa, 0); err != nil {
				return err
			}
			if err = windows.SetHandleInformation(wr, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
				windows.CloseHandle(stdin)
				windows.CloseHandle(wr)
				return err
			}
			input = os.NewFile(uintptr(wr), "child-control-input")
		} else {
			nul, _ := windows.UTF16PtrFromString("NUL")
			stdin, err = windows.CreateFile(nul, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_EXISTING, 0, 0)
			if err != nil {
				return err
			}
		}
		childHandles = append(childHandles, stdin)
		for _, name := range []string{"stdout", "stderr"} {
			var rd, wr windows.Handle
			if err = windows.CreatePipe(&rd, &wr, sa, 0); err != nil {
				return err
			}
			if err = windows.SetHandleInformation(rd, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
				windows.CloseHandle(rd)
				windows.CloseHandle(wr)
				return err
			}
			outputs = append(outputs, os.NewFile(uintptr(rd), name))
			childHandles = append(childHandles, wr)
		}
		si.Flags |= windows.STARTF_USESTDHANDLES
		si.StdInput, si.StdOutput, si.StdErr = childHandles[0], childHandles[1], childHandles[2]
		if err = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&childHandles[0]), uintptr(len(childHandles))*unsafe.Sizeof(childHandles[0])); err != nil {
			return err
		}
	}
	block, err := environment(r.Env)
	if err != nil {
		return err
	}
	app, _ := windows.UTF16PtrFromString(r.Exe)
	cwd, _ := windows.UTF16PtrFromString(r.Cwd)
	line := windows.ComposeCommandLine(append([]string{r.Exe}, r.Args...))
	// Windows limits UTF-16 code units, not Unicode scalar values.
	wideLine, err := windows.UTF16FromString(line)
	if err != nil || len(wideLine) > 30000 {
		return errors.New("shell launch exceeds Windows command-line limit; use a script file")
	}
	cmd := &wideLine[0]
	pi := windows.ProcessInformation{}
	if err = windows.CreateProcess(app, cmd, nil, nil, !r.TTY, flags, &block[0], cwd, &si.StartupInfo, &pi); err != nil {
		if console != 0 {
			windows.ClosePseudoConsole(console)
		}
		return fmt.Errorf("create suspended child: %w", err)
	}
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	// A failed assignment MUST NOT fall back to an uncontained running process.
	if err = windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		windows.TerminateProcess(pi.Process, 125)
		if console != 0 {
			windows.ClosePseudoConsole(console)
		}
		return fmt.Errorf("assign process job before execution: %w", err)
	}
	for _, h := range childHandles {
		windows.CloseHandle(h)
	}
	childHandles = nil
	// ConPTY itself can emit terminal negotiation bytes before the suspended
	// application runs. Publish identity before any reader may emit a data frame.
	e.send(map[string]any{"type": "ready", "pid": pi.ProcessId, "protocol": protocol})
	var readers sync.WaitGroup
	for _, file := range outputs {
		readers.Add(1)
		go func(f *os.File) {
			defer readers.Done()
			buf := make([]byte, 16384)
			for {
				n, x := f.Read(buf)
				if n > 0 {
					e.send(map[string]any{"type": "data", "stream": f.Name(), "data": buf[:n]})
				}
				if x != nil {
					return
				}
			}
		}(file)
	}
	if _, err = windows.ResumeThread(pi.Thread); err != nil {
		return err
	}
	// A child that never reads input can block WriteFile indefinitely. Keep the
	// parent control reader independent so forced termination and parent EOF are
	// always actionable, even while terminal/application input is backpressured.
	inputQueue := make(chan []byte, 16)
	var inputBytes atomic.Int64
	controlFailure := make(chan error, 1)
	failControl := func(message string) {
		select {
		case controlFailure <- errors.New(message):
		default:
		}
		_ = windows.TerminateJobObject(job, 125)
	}
	go func() {
		for data := range inputQueue {
			if input != nil {
				_, _ = input.Write(data)
			}
			inputBytes.Add(-int64(len(data)))
		}
	}()
	enqueueInput := func(data []byte) bool {
		if len(data) == 0 {
			return true
		}
		if input == nil {
			failControl("child input is closed")
			return false
		}
		if inputBytes.Add(int64(len(data))) > maxRequest {
			inputBytes.Add(-int64(len(data)))
			failControl("Windows child input queue exceeded its byte budget")
			return false
		}
		select {
		case inputQueue <- data:
			return true
		default:
			inputBytes.Add(-int64(len(data)))
			failControl("Windows child input queue exceeded its frame budget")
			return false
		}
	}
	// Control uses a private inherited pipe, never tool output or a guessable port.
	go func() {
		defer close(inputQueue)
		for scanner.Scan() {
			var c request
			if json.Unmarshal(scanner.Bytes(), &c) != nil {
				failControl("invalid Windows control request")
				return
			}
			switch c.Type {
			case "input":
				if !enqueueInput(c.Data) {
					return
				}
			case "terminate":
				if r.TTY && !c.Force {
					if !enqueueInput([]byte{3}) {
						return
					}
				} else {
					_ = windows.TerminateJobObject(job, 1)
				}
			default:
				failControl("unknown Windows control request")
				return
			}
		}
		if scanner.Err() != nil {
			failControl("Windows control channel read failed or exceeded its limit")
			return
		}
		// Parent died/disconnected: close every owned descendant, not just the shell.
		_ = windows.TerminateJobObject(job, 1)
	}()
	if _, err = windows.WaitForSingleObject(pi.Process, windows.INFINITE); err != nil {
		return err
	}
	var code uint32
	if err = windows.GetExitCodeProcess(pi.Process, &code); err != nil {
		return err
	}
	// A completed command may not leave detached children behind. Long-running
	// tasks must keep their shell alive and use the normal session handle.
	if err = windows.TerminateJobObject(job, 1); err != nil {
		return fmt.Errorf("terminate owned descendants: %w", err)
	}
	if console != 0 {
		// ClosePseudoConsole can block until output drains. Keep readers live.
		done := make(chan struct{})
		go func() { windows.ClosePseudoConsole(console); close(done) }()
		readers.Wait()
		<-done
	} else {
		readers.Wait()
	}
	// A signalled root process does not alone prove that detached descendants
	// have exited. Query this owned Job rather than looking up recyclable PIDs.
	if err = waitJobEmpty(job); err != nil {
		return err
	}
	select {
	case err = <-controlFailure:
		return err
	default:
	}
	e.send(map[string]any{"type": "exit", "code": code})
	return nil
}

func waitJobEmpty(job windows.Handle) error {
	// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION has architecture-independent
	// LARGE_INTEGER/DWORD fields on supported x64 and ARM64 Windows.
	var info struct {
		TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime       int64
		TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses uint32
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := windows.QueryInformationJobObject(job, 1, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
			return err
		}
		if info.ActiveProcesses == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("owned descendant termination was not confirmed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func detachedCommand() error {
	s := bufio.NewScanner(io.LimitReader(os.Stdin, maxRequest))
	s.Buffer(make([]byte, 65536), maxRequest)
	r, err := decodeStart(s)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(r.Log) {
		return errors.New("absolute launcher log required")
	}
	f, err := os.OpenFile(r.Log, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	// Use the standard library for a non-inheriting detached launcher. The new
	// supervisor owns its own job-backed children; it does not share this host's Job.
	return launchDetached(r, f)
}
