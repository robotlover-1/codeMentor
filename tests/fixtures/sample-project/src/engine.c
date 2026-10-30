#include "engine.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static PID_TypeDef g_pid;

void pid_reset(PID_TypeDef *pid) {
    memset(pid, 0, sizeof(PID_TypeDef));
    pid->enabled = 1;
}

void pid_set(PID_TypeDef *pid, float target) {
    pid->target = target;
}

float pid_compute(PID_TypeDef *pid, float actual) {
    float error = pid->target - actual;
    pid->output = pid->kp * error + pid->ki * error + pid->kd * error;
    return pid->output;
}

void engine_init(void) {
    pid_reset(&g_pid);
    g_pid.kp = 1.0f;
}

void engine_set_target(float target) {
    pid_set(&g_pid, target);
}

float engine_step(float actual) {
    return pid_compute(&g_pid, actual);
}

void engine_report(const char *text) {
    char buffer[16];
    sprintf(buffer, "%s", text);
    HAL_UART_Transmit(buffer);
    char *copy = malloc(sizeof(PID_TypeDef));
    memcpy(copy, &g_pid, sizeof(PID_TypeDef));
}
