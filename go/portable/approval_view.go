package portable

import "github.com/daniel-ballance/modular-agent/go/api"

// WithoutApprovalView removes the private attestation from both forms of a portable entry.
func WithoutApprovalView(e api.Entry) api.Entry {
	if e.Kind != "question.answer" {
		return e
	}
	a := api.Decode[api.Answer](e.Data)
	if a.ApprovalView != nil {
		a.ApprovalView = nil
		e.Data = api.JSON(a)
	}
	if len(e.Wire) > 0 {
		v := obj(e.Wire)
		d := asObject(v["data"])
		delete(d, "approvalView")
		v["data"] = d
		e.Wire = api.JSON(v)
	}
	return e
}
