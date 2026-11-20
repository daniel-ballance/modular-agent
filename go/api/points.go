package api

import "context"

// EnvironmentPoints is optional. Points are opaque and belong to the
// environment, project and execution session that saved them. CheckPoint is
// read-only. Both check and restore match fs.ErrNotExist for an unknown,
// expired or foreign point, without changing project files.
type EnvironmentPoints interface {
	SupportsPoints() bool
	SavePoint(ctx context.Context, project string) (string, error)
	CheckPoint(ctx context.Context, project, point string) error
	RestorePoint(ctx context.Context, project, point string) error
}

func Points(env WorkingEnvironment) (EnvironmentPoints, bool) {
	points, ok := env.(EnvironmentPoints)
	return points, ok && points.SupportsPoints()
}

// PointsFor reports whether the environment can keep points for this project.
// Environments without a project-specific policy use their static declaration.
func PointsFor(env WorkingEnvironment, project string) (EnvironmentPoints, bool) {
	points, ok := Points(env)
	if scoped, hasPolicy := env.(interface{ KeepsPoints(string) bool }); ok && hasPolicy {
		ok = scoped.KeepsPoints(project)
	}
	return points, ok
}
