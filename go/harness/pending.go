package harness

import "github.com/daniel-ballance/modular-agent/go/api"

func unfinished(s api.Session) bool {
	if len(api.OpenCalls(s)) > 0 {
		return true
	}
	return hasUnfinishedJobs(s)
}

func hasUnfinishedJobs(s api.Session) bool {
	jobs := map[string]bool{}
	for _, e := range s.LiveEntries() {
		switch {
		case e.Kind == "job.start" && e.Session == s.ID:
			jobs[e.Job] = true
		case e.Kind == "job.end" || e.OriginalKind == "job.end":
			delete(jobs, e.Job)
		}
	}
	return len(jobs) != 0
}
