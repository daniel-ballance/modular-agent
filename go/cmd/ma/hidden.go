package main

import (
	"io"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

type echoControl interface {
	echoOff() (restore func(), err error)
}

// hiddenInput is nil when in is not a terminal.
func hiddenInput(in io.Reader) echoControl {
	if e, ok := in.(echoControl); ok {
		return e
	}
	f, ok := in.(*os.File)
	if !ok {
		return nil
	}
	// SyscallConn leaves the descriptor's blocking mode alone; Fd would change it.
	conn, err := f.SyscallConn()
	if err != nil {
		return nil
	}
	t := terminal{conn}
	if t.control(func(fd int) error { _, err := unix.IoctlGetTermios(fd, getTermios); return err }) != nil {
		return nil
	}
	return t
}

type terminal struct{ conn syscall.RawConn }

func (t terminal) control(f func(fd int) error) error {
	var err error
	if e := t.conn.Control(func(fd uintptr) { err = f(int(fd)) }); e != nil {
		return e
	}
	return err
}

func (t terminal) echoOff() (func(), error) {
	var saved *unix.Termios
	err := t.control(func(fd int) error {
		var err error
		if saved, err = unix.IoctlGetTermios(fd, getTermios); err != nil {
			return err
		}
		quiet := *saved
		quiet.Lflag &^= unix.ECHO
		// Flushing drops typeahead, which the terminal has already shown.
		return unix.IoctlSetTermios(fd, setTermiosFlush, &quiet)
	})
	if err != nil {
		return nil, err
	}
	return func() { _ = t.control(func(fd int) error { return unix.IoctlSetTermios(fd, setTermios, saved) }) }, nil
}
