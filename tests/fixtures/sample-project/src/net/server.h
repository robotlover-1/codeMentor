#ifndef SERVER_H
#define SERVER_H

typedef struct {
    int port;
    int connected;
} net_config;

void server_start(void);
int net_connect(void);
int net_send(const char *text);

#endif
