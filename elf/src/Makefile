# Build the standalone eci_synth tool ecobox's ELF TTS provider spawns.
# Output: ../bin/eci_synth. Run `make` after a fresh checkout or arch change.
CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra
LDFLAGS ?= -ldl
SRC      = eci_synth.c eci/runtime.c eci/engine.c eci/languages.c eci/voices.c
OUT      = ../bin/eci_synth

$(OUT): $(SRC) eci/*.h config.h
	mkdir -p ../bin
	$(CC) $(CFLAGS) -o $(OUT) $(SRC) $(LDFLAGS)

clean:
	rm -f $(OUT)

.PHONY: clean
