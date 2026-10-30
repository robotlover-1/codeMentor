#ifndef ENGINE_H
#define ENGINE_H

typedef struct {
    float kp;
    float ki;
    float kd;
    float target;
    float output;
    int enabled;
} PID_TypeDef;

void engine_init(void);
void engine_set_target(float target);
float engine_step(float actual);
void engine_report(const char *text);

void pid_reset(PID_TypeDef *pid);
void pid_set(PID_TypeDef *pid, float target);
float pid_compute(PID_TypeDef *pid, float actual);

#endif
