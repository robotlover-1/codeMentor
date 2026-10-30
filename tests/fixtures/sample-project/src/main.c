#include "engine.h"
#include "net/server.h"

int main(void) {
    engine_init();
    engine_set_target(42.0f);
    server_start();
    /* TODO: handle engine_step failure path */
    return 0;
}
