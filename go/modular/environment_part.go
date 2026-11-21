package modular

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"runtime"
	"slices"
	"time"

	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/pluginrpc"
)

// EnvironmentDeclaration is the working environment's binding registration.
type EnvironmentDeclaration struct {
	Containment   string   `json:"containment"`
	Platforms     []string `json:"platforms,omitempty"`
	Points        bool     `json:"points,omitempty"`
	ConfinesFiles bool     `json:"confinesFiles,omitempty"`
}

type EnvironmentPath struct{ SessionID, Cwd, Path string }
type EnvironmentWrite struct {
	EnvironmentPath
	Data []byte
}
type EnvironmentExec struct {
	SessionID, Cwd, Command string
	Timeout                 time.Duration
}
type EnvironmentPoint struct{ SessionID, Cwd, Point string }

// WorkingEnvironment implements the binding operations. Return NotSupported
// for optional operations not supplied. The implementation owns confinement,
// point identities, and cleanup, within its declared scope.
type WorkingEnvironment interface {
	Declaration() EnvironmentDeclaration
	Read(context.Context, EnvironmentPath) ([]byte, error)
	Exists(context.Context, EnvironmentPath) (bool, error)
	Write(context.Context, EnvironmentWrite) error
	Exec(context.Context, EnvironmentExec, func(string)) (ExecResult, error)
	List(context.Context, EnvironmentPath) ([]DirEntry, error)
	SavePoint(context.Context, EnvironmentPoint) (string, error)
	CheckPoint(context.Context, EnvironmentPoint) (bool, error)
	RestorePoint(context.Context, EnvironmentPoint) error
	SessionEnded(context.Context, string) error
}

// NewEnvironment adapts binding-shaped operations for WithEnvironment or
// Registrar.Environment. Plugin.Stop can release instance-wide resources.
func NewEnvironment(impl WorkingEnvironment) Environment {
	if impl == nil {
		return nil
	}
	d := impl.Declaration()
	if d.Containment == "" {
		d.Containment = "none"
	}
	d.Platforms = slices.Clone(d.Platforms)
	return environmentPart{impl, d}
}

type environmentPart struct {
	impl        WorkingEnvironment
	declaration EnvironmentDeclaration
}

func (e environmentPart) Containment() string {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	if !slices.Contains(e.declaration.Platforms, platform) {
		return "none"
	}
	return e.declaration.Containment
}

// Containment does not prove cleanup of a previous, interrupted call.
func (e environmentPart) StopsOnCrash() bool   { return false }
func (e environmentPart) ConfinesFiles() bool  { return e.declaration.ConfinesFiles }
func (e environmentPart) SupportsPoints() bool { return e.declaration.Points }
func (e environmentPart) Close() error         { return nil }
func (e environmentPart) SessionEnded(ctx context.Context, id string) error {
	return environmentError(e.impl.SessionEnded(ctx, id))
}
func envPath(ctx context.Context, cwd, path string) EnvironmentPath {
	return EnvironmentPath{api.Executing(ctx).Session, cwd, path}
}
func envPoint(ctx context.Context, cwd, point string) EnvironmentPoint {
	return EnvironmentPoint{api.Executing(ctx).Session, cwd, point}
}
func (e environmentPart) Read(ctx context.Context, cwd, path string) ([]byte, error) {
	b, err := e.impl.Read(ctx, envPath(ctx, cwd, path))
	return b, environmentError(err)
}
func (e environmentPart) Exists(ctx context.Context, cwd, path string) (bool, error) {
	ok, err := e.impl.Exists(ctx, envPath(ctx, cwd, path))
	return ok, environmentError(err)
}
func (e environmentPart) Write(ctx context.Context, cwd, path string, b []byte) error {
	return environmentError(e.impl.Write(ctx, EnvironmentWrite{envPath(ctx, cwd, path), b}))
}
func (e environmentPart) ListDir(ctx context.Context, cwd, path string) ([]DirEntry, error) {
	entries, err := e.impl.List(ctx, envPath(ctx, cwd, path))
	return entries, environmentError(err)
}
func (e environmentPart) Exec(ctx context.Context, cwd, command string, timeout time.Duration, progress func(string)) (ExecResult, error) {
	if progress == nil {
		progress = func(string) {}
	}
	out, err := e.impl.Exec(ctx, EnvironmentExec{api.Executing(ctx).Session, cwd, command, timeout}, progress)
	return out, environmentError(err)
}
func (e environmentPart) Bash(ctx context.Context, cwd, command string, progress func(string)) (string, error) {
	r, err := e.Exec(ctx, cwd, command, 0, progress)
	if err == nil && (r.ExitCode == nil || *r.ExitCode != 0) {
		err = fmt.Errorf("command did not exit successfully")
	}
	return r.Output, err
}
func (e environmentPart) SavePoint(ctx context.Context, cwd string) (string, error) {
	id, err := e.impl.SavePoint(ctx, envPoint(ctx, cwd, ""))
	return id, environmentError(err)
}
func (e environmentPart) CheckPoint(ctx context.Context, cwd, point string) error {
	ok, err := e.impl.CheckPoint(ctx, envPoint(ctx, cwd, point))
	if err == nil && !ok {
		return fs.ErrNotExist
	}
	return environmentError(err)
}
func (e environmentPart) RestorePoint(ctx context.Context, cwd, point string) error {
	return environmentError(e.impl.RestorePoint(ctx, envPoint(ctx, cwd, point)))
}

func environmentError(err error) error {
	var e *Error
	if !errors.As(err, &e) {
		return err
	}
	switch e.Code {
	case NotFound:
		return errors.Join(fs.ErrNotExist, serveFault(err))
	case NotSupported:
		return errors.Join(errors.ErrUnsupported, api.ErrListUnsupported, serveFault(err))
	case Lost:
		return errors.Join(api.ErrUnknownOutcome, serveFault(err))
	default:
		return serveFault(err)
	}
}

func setupEnvironment(a api.API, env Environment) error {
	if err := a.Provide("working-environment", env); err != nil {
		return err
	}
	if e, ok := env.(interface {
		SessionEnded(context.Context, string) error
	}); ok {
		for _, hook := range []string{"session.stop", "session.end"} {
			if err := a.Handle(hook, "last", func(ctx context.Context, v any) (api.Decision, error) {
				return api.Decision{}, e.SessionEnded(ctx, v.(string))
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func environmentRegistration(env Environment) *pluginrpc.EnvironmentRegistration {
	if e, ok := env.(environmentPart); ok {
		d := e.declaration
		return &pluginrpc.EnvironmentRegistration{Containment: d.Containment, Platforms: d.Platforms, Points: d.Points, ConfinesFiles: d.ConfinesFiles}
	}
	d := &pluginrpc.EnvironmentRegistration{Containment: "none", Platforms: []string{runtime.GOOS}}
	if runtime.GOOS == "windows" {
		d.Platforms[0] = "win32"
	}
	if c, ok := env.(interface{ Containment() string }); ok {
		d.Containment = c.Containment()
	}
	if c, ok := env.(interface{ ConfinesFiles() bool }); ok {
		d.ConfinesFiles = c.ConfinesFiles()
	}
	_, d.Points = api.Points(env)
	return d
}
