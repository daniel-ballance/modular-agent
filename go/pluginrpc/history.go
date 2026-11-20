package pluginrpc

import (
	"github.com/daniel-ballance/modular-agent/go/api"
	"github.com/daniel-ballance/modular-agent/go/portable"
)

func entryOut(e api.Entry) object {
	return portable.Entry(e)
}
