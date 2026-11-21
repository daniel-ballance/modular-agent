package local

import (
	"errors"

	"golang.org/x/sys/unix"
)

func rejectProjectMounts(project string) error {
	count, err := unix.Getfsstat(nil, unix.MNT_NOWAIT)
	if err != nil {
		return err
	}
	mounts := make([]unix.Statfs_t, count)
	n, err := unix.Getfsstat(mounts, unix.MNT_NOWAIT)
	if err != nil || n > len(mounts) {
		return errors.Join(err, errors.New("cannot read project mount table"))
	}
	for _, mount := range mounts[:n] {
		if within(project, unix.ByteSliceToString(mount.Mntonname[:])) {
			return errors.New("project contains a mount; cannot safely save or restore its files")
		}
	}
	return nil
}
