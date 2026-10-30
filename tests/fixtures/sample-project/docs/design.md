# Design notes

The controller is split into a PID engine (`src/engine.c`) and a network
service (`src/net/server.c`). `main` wires them together and owns the process
entry point.
