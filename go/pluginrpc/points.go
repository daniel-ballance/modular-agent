package pluginrpc

import (
	"context"
	"errors"
	"github.com/OWNER/modular-agent/go/api"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func pointRequest(ctx context.Context, env api.WorkingEnvironment, project, method string, v object) (any, error) {
	points, ok := api.Points(env)
	if !ok {
		return nil, fault("not_supported", "working environment does not support points")
	}
	session, cwd := str(v, "sessionId"), str(v, "cwd")
	if session == "" || !cwdInProject(project, cwd) {
		return nil, fault("invalid_request", "sessionId and a cwd within the initialized project are required")
	}
	ctx = api.WithExecution(ctx, api.Execution{Session: session})
	if method == "env/save" {
		point, err := points.SavePoint(ctx, project)
		if err == nil && point == "" {
			return nil, errors.New("environment returned an empty point")
		}
		return object{"point": point}, err
	}
	point := str(v, "point")
	if point == "" {
		return nil, fault("invalid_request", "point is required")
	}
	if method == "env/checkPoint" {
		err := points.CheckPoint(ctx, project, point)
		if errors.Is(err, fs.ErrNotExist) {
			return object{"exists": false}, nil
		}
		return object{"exists": err == nil}, err
	}
	err := points.RestorePoint(ctx, project, point)
	if errors.Is(err, fs.ErrNotExist) {
		err = fault("not_found", "no such point in this working environment for this project")
	}
	return object{}, err
}

func cwdInProject(project, cwd string) bool {
	if !filepath.IsAbs(cwd) {
		return false
	}
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(project, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	info, err := os.Stat(resolved)
	return err == nil && info.IsDir()
}

func (e *remoteEnvironment) SupportsPoints() bool { return e.points }

func (e *remoteEnvironment) SavePoint(ctx context.Context, cwd string) (string, error) {
	var v struct {
		Point string `json:"point"`
	}
	if !e.points {
		return "", fault("not_supported", "working environment does not support points")
	}
	err := e.request(ctx, "env/save", object{"cwd": cwd}, &v)
	if err == nil && v.Point == "" {
		err = errors.New("environment returned an empty point")
	}
	return v.Point, err
}

func (e *remoteEnvironment) CheckPoint(ctx context.Context, cwd, point string) error {
	if !e.points {
		return fault("not_supported", "working environment does not support points")
	}
	var v struct {
		Exists *bool `json:"exists"`
	}
	if err := e.request(ctx, "env/checkPoint", object{"cwd": cwd, "point": point}, &v); err != nil {
		return err
	}
	if v.Exists == nil {
		return errors.New("working environment returned no point check result")
	}
	if !*v.Exists {
		return fs.ErrNotExist
	}
	return nil
}

func (e *remoteEnvironment) RestorePoint(ctx context.Context, cwd, point string) error {
	if !e.points {
		return fault("not_supported", "working environment does not support points")
	}
	return e.request(ctx, "env/restore", object{"cwd": cwd, "point": point}, nil)
}
