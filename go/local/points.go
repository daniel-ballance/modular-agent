package local

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"modular/api"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func (e *Environment) SupportsPoints() bool { return e.initErr == nil }

func (e *Environment) pointProject(cwd string) (string, map[string]bool, error) {
	project, err := filepath.EvalSymlinks(cwd)
	if err == nil {
		project, err = filepath.Abs(project)
	}
	if err != nil {
		return "", nil, err
	}
	if project == filepath.Dir(project) {
		return "", nil, errors.New("the filesystem root cannot be saved as a project")
	}
	if err := rejectProjectMounts(project); err != nil {
		return "", nil, err
	}
	skip := map[string]bool{}
	for _, state := range e.stateDirs {
		if state == "" {
			continue
		}
		// Resolve symlinks in state as well, so a snapshot never copies itself.
		state, err := filepath.EvalSymlinks(state)
		if err != nil {
			return "", nil, err
		}
		state, err = filepath.Abs(state)
		if err != nil {
			return "", nil, err
		}
		if project == state || within(state, project) {
			return "", nil, errors.New("project overlaps the agent's own state")
		}
		if within(project, state) {
			rel, _ := filepath.Rel(project, state)
			skip[rel] = true
		}
	}
	return project, skip, nil
}

func within(parent, child string) bool {
	return strings.HasPrefix(child, parent+string(filepath.Separator))
}

// Never copy or clean up through a separate mount, including a bind mount
// that would look like the project filesystem to a device-number check.
func rejectProjectMounts(project string) error {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	unescape := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 5 && within(project, unescape.Replace(fields[4])) {
			return errors.New("project contains a mount; cannot safely save or restore its files")
		}
	}
	return scanner.Err()
}

func (e *Environment) SavePoint(ctx context.Context, cwd string) (string, error) {
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	if !e.SupportsPoints() {
		return "", e.initErr
	}
	project, skip, err := e.pointProject(cwd)
	if err != nil {
		return "", err
	}
	parent := filepath.Join(e.root, "points")
	if err = os.MkdirAll(parent, 0700); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, ".save-")
	if err != nil {
		return "", err
	}
	defer removePointTree(stage)
	if err = os.WriteFile(filepath.Join(stage, "project"), []byte(project), 0600); err != nil {
		return "", err
	}
	if err = os.WriteFile(filepath.Join(stage, "session"), []byte(api.Executing(ctx).Session), 0600); err != nil {
		return "", err
	}
	if err = copyPoint(ctx, project, filepath.Join(stage, "files"), skip); err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	point := api.ID()
	if err = os.Rename(stage, filepath.Join(parent, point)); err != nil {
		return "", err
	}
	return point, nil
}

func (e *Environment) CheckPoint(ctx context.Context, cwd, point string) error {
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	project, _, err := e.pointProject(cwd)
	if err != nil {
		return err
	}
	return e.checkPoint(ctx, project, point)
}

func (e *Environment) checkPoint(ctx context.Context, project, point string) error {
	if !e.SupportsPoints() {
		return e.initErr
	}
	if id, err := hex.DecodeString(point); err != nil || len(id) != 16 {
		return fs.ErrNotExist
	}
	saved := filepath.Join(e.root, "points", point)
	owner, err := os.ReadFile(filepath.Join(saved, "project"))
	if err != nil {
		return err
	}
	if string(owner) != project {
		return fs.ErrNotExist
	}
	session, err := os.ReadFile(filepath.Join(saved, "session"))
	if err != nil {
		return err
	}
	if string(session) != api.Executing(ctx).Session {
		return fs.ErrNotExist
	}
	files, err := os.Lstat(filepath.Join(saved, "files"))
	if err != nil {
		return err
	}
	if !files.IsDir() {
		return errors.New("point has an invalid file tree")
	}
	return nil
}

func (e *Environment) RestorePoint(ctx context.Context, cwd, point string) error {
	e.pointsMu.Lock()
	defer e.pointsMu.Unlock()
	project, skip, err := e.pointProject(cwd)
	if err != nil {
		return err
	}
	if err = e.checkPoint(ctx, project, point); err != nil {
		return err
	}
	saved := filepath.Join(e.root, "points", point)
	// Stage inside the project so renames stay on its filesystem, without
	// replacing the project directory (which may be somebody's current cwd).
	stage, err := os.MkdirTemp(project, ".modular-restore-")
	if err != nil {
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			removePointTree(stage)
		}
	}()
	base := filepath.Base(stage)
	skip[base] = true
	if err = copyPoint(ctx, filepath.Join(saved, "files"), filepath.Join(stage, "files"), nil); err != nil {
		return err
	}
	root, err := os.OpenRoot(project)
	if err != nil {
		return err
	}
	defer root.Close()
	var plan []pointRename
	if err = planPoint(root, ".", filepath.Join(base, "files"), filepath.Join(base, "old"), skip, &plan); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	for i, move := range plan {
		if err = root.Rename(move.from, move.to); err != nil {
			// Roll back completed renames in reverse order. Keep the backup if
			// someone concurrently modified the tree and rollback also failed.
			for j := i - 1; j >= 0; j-- {
				if undo := root.Rename(plan[j].to, plan[j].from); undo != nil {
					cleanup = false
					err = errors.Join(err, fmt.Errorf("restore rollback failed (backup in %s): %w", stage, undo))
				}
			}
			return err
		}
	}
	return nil
}

func copyPoint(ctx context.Context, src, dest string, skip map[string]bool) error {
	root, err := os.OpenRoot(src)
	if err != nil {
		return err
	}
	defer root.Close()
	var dirs []struct {
		path string
		mode fs.FileMode
	}
	err = fs.WalkDir(root.FS(), ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if skip[name] {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		target := filepath.Join(dest, name)
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case d.IsDir():
			if name != "." {
				dirs = append(dirs, struct {
					path string
					mode fs.FileMode
				}{target, mode.Perm()})
			}
			return os.Mkdir(target, 0700)
		case mode&fs.ModeSymlink != 0:
			link, err := root.Readlink(name)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case mode.IsRegular():
			in, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return err
			}
			defer in.Close()
			if current, err := in.Stat(); err != nil || !os.SameFile(info, current) {
				return fmt.Errorf("file changed while saving point: %s", name)
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, in)
			return errors.Join(err, out.Chmod(mode.Perm()), out.Close())
		default:
			return fmt.Errorf("cannot snapshot special file %s", name)
		}
	})
	if err != nil {
		return err
	}
	for i := len(dirs) - 1; i >= 0; i-- {
		if err = os.Chmod(dirs[i].path, dirs[i].mode); err != nil {
			return err
		}
	}
	return nil
}

type pointRename struct{ from, to string }

// Plan all mutations before applying any. Ancestors of the agent's own state
// folders are left in place, but their project files still participate.
func planPoint(root *os.Root, current, saved, backup string, skip map[string]bool, plan *[]pointRename) error {
	if err := root.Mkdir(backup, 0700); err != nil {
		return err
	}
	old, err := fs.ReadDir(root.FS(), current)
	if err != nil {
		return err
	}
	new, err := fs.ReadDir(root.FS(), saved)
	if err != nil {
		return err
	}
	folders := map[string]bool{}
	for _, d := range old {
		name := filepath.Join(current, d.Name())
		if skip[name] {
			continue
		}
		for dir := range skip {
			if within(name, dir) {
				if !d.IsDir() {
					return errors.New("agent state path changed during restore")
				}
				folders[d.Name()] = true
			}
		}
		if !folders[d.Name()] {
			*plan = append(*plan, pointRename{name, filepath.Join(backup, d.Name())})
		}
	}
	for _, d := range new {
		name := filepath.Join(current, d.Name())
		if skip[name] {
			continue
		}
		from := filepath.Join(saved, d.Name())
		if folders[d.Name()] {
			delete(folders, d.Name())
			if !d.IsDir() {
				return errors.New("point would replace an ancestor of agent state")
			}
			if err := planPoint(root, name, from, filepath.Join(backup, d.Name()), skip, plan); err != nil {
				return err
			}
		} else {
			*plan = append(*plan, pointRename{from, name})
		}
	}
	if len(folders) != 0 {
		return errors.New("point lacks an ancestor of agent state")
	}
	return nil
}

func removePointTree(path string) {
	// The original or staged tree may contain read-only directories.
	_ = filepath.WalkDir(path, func(name string, d fs.DirEntry, err error) error {
		if err == nil && d.IsDir() {
			_ = os.Chmod(name, 0700)
		}
		return nil
	})
	_ = os.RemoveAll(path)
}
