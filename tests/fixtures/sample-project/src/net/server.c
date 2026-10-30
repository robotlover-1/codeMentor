#include "server.h"

static net_config g_config;

int net_connect(void) {
    g_config.port = 9000;
    g_config.connected = 1;
    return 0;
}

int net_send(const char *text) {
    if (g_config.connected) {
        return 0;
    }
    return -1;
}

void server_start(void) {
    net_connect();
    net_send("ready");
    /* FIXME: retry when the peer is not ready */
}
