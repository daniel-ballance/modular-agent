package local

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/daniel-ballance/modular-agent/go/api"
)

type pointRepo struct {
	top, project, prefix, spec string
}

func pointGit(ctx context.Context, top, index string, input []byte, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", top, "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false"}, args...)...)
	for _, item := range os.Environ() {
		key, _, _ := strings.Cut(item, "=")
		switch key {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY":
		default:
			cmd.Env = append(cmd.Env, item)
		}
	}
	cmd.Env = append(cmd.Env, "GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "GIT_AUTHOR_NAME=modular-agent", "GIT_COMMITTER_NAME=modular-agent", "GIT_AUTHOR_EMAIL=points@modular-agent.invalid", "GIT_COMMITTER_EMAIL=points@modular-agent.invalid")
	if index != "" {
		cmd.Env = append(cmd.Env, "GIT_INDEX_FILE="+index)
	}
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func discoverPointRepo(ctx context.Context, project string) (pointRepo, error) {
	project, err := filepath.Abs(project)
	if err == nil {
		project, err = filepath.EvalSymlinks(project)
	}
	if err != nil {
		return pointRepo{}, err
	}
	out, err := pointGit(ctx, project, "", nil, "rev-parse", "--is-inside-work-tree", "--show-toplevel")
	if err != nil {
		return pointRepo{}, err
	}
	path, ok := strings.CutPrefix(string(out), "true\n")
	if !ok {
		return pointRepo{}, errors.New("project is not in a Git work tree")
	}
	top, err := filepath.EvalSymlinks(strings.TrimSuffix(path, "\n"))
	if err != nil {
		return pointRepo{}, err
	}
	prefix, err := filepath.Rel(top, project)
	if err != nil || prefix == ".." || strings.HasPrefix(prefix, ".."+string(filepath.Separator)) {
		return pointRepo{}, errors.New("project is outside the Git work tree")
	}
	return pointRepo{top, project, prefix, ":(literal)" + prefix}, nil
}

func (e *Environment) gitPointRepo(ctx context.Context, project string) (pointRepo, error) {
	repo, err := discoverPointRepo(ctx, project)
	if err != nil {
		return pointRepo{}, err
	}
	for _, dir := range e.stateDirs {
		if dir == "" {
			continue
		}
		state, err := filepath.Abs(dir)
		if err != nil {
			return pointRepo{}, err
		}
		if real, err := filepath.EvalSymlinks(state); err == nil {
			state = real
		}
		if state == repo.project || within(repo.project, state) {
			return pointRepo{}, errors.New("environment state is inside the project")
		}
	}
	return repo, nil
}

func pointRef(session, point string) (string, error) {
	for _, name := range []string{session, point} {
		if name == "" || strings.ContainsFunc(name, func(c rune) bool {
			return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_')
		}) {
			return "", errors.New("invalid session or point id")
		}
	}
	return "refs/modular-agent/points/" + session + "/" + point, nil
}

func (r pointRepo) git(ctx context.Context, args ...string) (string, error) {
	out, err := pointGit(ctx, r.top, "", nil, args...)
	return strings.TrimSuffix(string(out), "\n"), err
}

func (r pointRepo) snapshot(ctx context.Context, scratch string) (string, error) {
	index := filepath.Join(scratch, "index")
	if err := os.Remove(index); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	real, err := r.git(ctx, "rev-parse", "--path-format=absolute", "--git-path", "index")
	if err != nil {
		return "", err
	}
	if err = seedIndex(real, index); err != nil {
		return "", err
	}
	if _, err = pointGit(ctx, r.top, index, nil, "add", "-A", "--", r.spec); err != nil {
		return "", err
	}
	if r.prefix != "." {
		outside, err := pointGit(ctx, r.top, index, nil, "ls-files", "-z", "--", ":(exclude,literal)"+r.prefix)
		if err != nil {
			return "", err
		}
		if len(outside) != 0 {
			if _, err = pointGit(ctx, r.top, index, outside, "update-index", "--force-remove", "-z", "--stdin"); err != nil {
				return "", err
			}
		}
	}
	out, err := pointGit(ctx, r.top, index, nil, "write-tree")
	return strings.TrimSuffix(string(out), "\n"), err
}

func seedIndex(real, index string) error {
	src, err := os.Open(real)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(index, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	return errors.Join(err, dst.Close())
}

func (r pointRepo) commit(ctx context.Context, tree, session string) (string, error) {
	message := fmt.Sprintf("modular-agent point\n\nsession: %s\nproject: %s\n", session, r.project)
	out, err := pointGit(ctx, r.top, "", []byte(message), "commit-tree", tree)
	return strings.TrimSuffix(string(out), "\n"), err
}

func (r pointRepo) save(ctx context.Context, session string) (string, error) {
	point := api.ID()
	name, err := pointRef(session, point)
	if err != nil {
		return "", err
	}
	scratch, err := os.MkdirTemp("", "ma-git-points-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(scratch)
	tree, err := r.snapshot(ctx, scratch)
	if err != nil {
		return "", err
	}
	commit, err := r.commit(ctx, tree, session)
	if err != nil {
		return "", err
	}
	if _, err = r.git(ctx, "update-ref", name, commit); err != nil {
		return "", err
	}
	return point, nil
}

func (r pointRepo) find(ctx context.Context, session, point string) (string, error) {
	name, err := pointRef(session, point)
	if err != nil {
		return "", fs.ErrNotExist
	}
	commit, err := r.git(ctx, "rev-parse", "--verify", "-q", name+"^{commit}")
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fs.ErrNotExist
	}
	body, err := r.git(ctx, "cat-file", "commit", commit)
	if err != nil {
		return "", err
	}
	if !strings.Contains(body+"\n", "\nproject: "+r.project+"\n") {
		return "", fs.ErrNotExist
	}
	return commit, nil
}

func (r pointRepo) apply(ctx context.Context, scratch, current, target string) error {
	diff := func(from, to string) ([]string, error) {
		out, err := pointGit(ctx, r.top, "", nil, "diff-tree", "-r", "-z", "--no-renames", "--name-only", "--diff-filter=A", from, to, "--", r.spec)
		return strings.Split(strings.TrimSuffix(string(out), "\x00"), "\x00"), err
	}
	removed, err := diff(target, current)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(r.project)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, name := range removed {
		if name == "" {
			continue
		}
		file, err := filepath.Rel(r.project, filepath.Join(r.top, name))
		if err != nil {
			return err
		}
		if meta, err := root.Lstat(file); err == nil && !meta.IsDir() {
			if err := root.Remove(file); err != nil {
				return err
			}
		} else if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		for dir := filepath.Dir(file); dir != "."; dir = filepath.Dir(dir) {
			if err := root.Remove(dir); err != nil {
				break
			}
		}
	}
	// Do not overwrite a newly ignored file or replace a symlink ancestor.
	added, err := diff(current, target)
	if err != nil {
		return err
	}
	for _, name := range added {
		if name == "" {
			continue
		}
		file, err := filepath.Rel(r.project, filepath.Join(r.top, name))
		if err != nil {
			return err
		}
		for path := file; path != "."; path = filepath.Dir(path) {
			meta, err := root.Lstat(path)
			if err == nil && (path == file || !meta.IsDir()) {
				return fmt.Errorf("cannot restore over %s", path)
			}
			if err != nil && !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	index := filepath.Join(scratch, "target")
	if _, err = pointGit(ctx, r.top, index, nil, "read-tree", target); err != nil {
		return err
	}
	files, err := pointGit(ctx, r.top, index, nil, "ls-files", "-z", "--", r.spec)
	if err == nil && len(files) != 0 {
		_, err = pointGit(ctx, r.top, index, files, "checkout-index", "-f", "-z", "--stdin")
	}
	return err
}

func (r pointRepo) restore(ctx context.Context, session, point string) error {
	saved, err := r.find(ctx, session, point)
	if err != nil {
		return err
	}
	target, err := r.git(ctx, "rev-parse", saved+"^{tree}")
	if err != nil {
		return err
	}
	scratch, err := os.MkdirTemp("", "ma-git-points-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	current, err := r.snapshot(ctx, scratch)
	if err != nil {
		return err
	}
	recovery := "refs/modular-agent/recovery/" + session + "/" + api.ID()
	kept, err := r.commit(ctx, current, session)
	if err != nil {
		return err
	}
	if _, err = r.git(ctx, "update-ref", recovery, kept); err != nil {
		return err
	}
	// Do not cancel compensation for a partially applied restore.
	cleanup := context.WithoutCancel(ctx)
	if err = r.apply(ctx, scratch, current, target); err != nil {
		after, snapshotErr := r.snapshot(cleanup, scratch)
		if snapshotErr != nil {
			after = target
		}
		if rollback := r.apply(cleanup, scratch, after, current); rollback != nil {
			return fmt.Errorf("restore and rollback failed; backup kept at %s: %w", recovery, errors.Join(err, rollback))
		}
	}
	_, _ = r.git(cleanup, "update-ref", "-d", recovery)
	return err
}
