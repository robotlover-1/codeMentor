#include "../src/engine.h"
#include <assert.h>

int test_engine_init(void) {
    engine_init();
    engine_set_target(10.0f);
    assert(engine_step(0.0f) >= 0.0f);
    return 0;
}
