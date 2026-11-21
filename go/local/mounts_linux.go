package local

import (
	"bufio"
	"errors"
	"os"
	"strings"
)

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
