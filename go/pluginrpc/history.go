package pluginrpc

import (
	"modular/api"
	"modular/portable"
)

func entryOut(e api.Entry) object {
	return portable.Entry(e)
}
