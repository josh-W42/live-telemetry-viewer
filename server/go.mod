module github.com/josh-W42/sift/server

go 1.26.0

require (
	connectrpc.com/connect v1.21.0
	connectrpc.com/cors v0.1.0
	github.com/rs/cors v1.11.1
	golang.org/x/net v0.59.0
	google.golang.org/protobuf v1.36.12
)

require golang.org/x/text v0.42.0 // indirect

tool (
	connectrpc.com/connect/cmd/protoc-gen-connect-go
	google.golang.org/protobuf/cmd/protoc-gen-go
)
