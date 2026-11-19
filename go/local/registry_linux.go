package local

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Host identities include boot and start time, never just a reusable PID.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
type processIdentity struct {
	PID         int
	Start, Boot string
}
type ownership struct{ Owner, Guardian processIdentity }

func identity(pid int) processIdentity {
	id := processIdentity{PID: pid}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return id
	}
	fields := strings.Fields(string(b)[strings.LastIndex(string(b), ")")+1:])
	if len(fields) > 19 {
		id.Start = fields[19]
	}
	boot, _ := os.ReadFile("/proc/sys/kernel/random/boot_id")
	id.Boot = strings.TrimSpace(string(boot))
	return id
}
func alive(id processIdentity) bool {
	if id.PID <= 0 || id.Start == "" {
		return false
	}
	current := identity(id.PID)
	if current != id {
		return false
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", id.PID))
	if err != nil {
		return false
	}
	fields := strings.Fields(string(b)[strings.LastIndex(string(b), ")")+1:])
	return len(fields) > 0 && fields[0] != "Z" && fields[0] != "X"
}
func (e *Environment) registryLock() (func(), error) {
	if err := os.MkdirAll(e.root, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(e.root, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
func saveRegistry(path string, value ownership) error {
	if value.Owner.Start == "" || value.Guardian.Start == "" {
		return errors.New("cannot identify command supervisor")
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".command-registry-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	err = json.NewEncoder(f).Encode(value)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func (e *Environment) cleanup() error {
	unlock, err := e.registryLock()
	if err != nil {
		return err
	}
	defer unlock()
	files, err := filepath.Glob(filepath.Join(e.root, "*.json"))
	if err != nil {
		return err
	}
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var owner ownership
		if err = json.Unmarshal(b, &owner); err != nil {
			return fmt.Errorf("invalid command registry %s: %w", file, err)
		}
		if alive(owner.Owner) && alive(owner.Guardian) {
			continue
		}
		if alive(owner.Guardian) {
			// SIGKILL of PID 1 tears down its whole namespace, including setsid.
			if err = syscall.Kill(owner.Guardian.PID, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
				return err
			}
			deadline := time.Now().Add(3 * time.Second)
			for alive(owner.Guardian) {
				if time.Now().After(deadline) {
					return errors.New("abandoned command supervisor did not stop: " + strconv.Itoa(owner.Guardian.PID))
				}
				time.Sleep(time.Millisecond)
			}
		}
		if err = os.Remove(file); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
