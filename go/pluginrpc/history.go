package pluginrpc

import (
	"github.com/OWNER/modular-agent/go/api"
	"github.com/OWNER/modular-agent/go/portable"
)

func entryOut(e api.Entry) object {
	return portable.Entry(e)
}
