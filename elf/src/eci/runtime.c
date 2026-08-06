/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * eci/runtime.c -- load the ECI runtime + populate an EciApi function table.
 *
 * Two runtimes, one table:
 *   - POSIX: dlopen() an eci.so (the Apple eci.dylib conversion). The engine
 *     registers global C++ destructors on load; calling dlclose runs them in an
 *     order that crashes inside libc atexit, so we leave the library mapped
 *     until process exit.
 *   - Windows: LoadLibrary() the original ECI.DLL (IBM/SpeechWorks
 *     ETI-Eloquence 6.1, 32-bit). Loaded with LOAD_WITH_ALTERED_SEARCH_PATH so
 *     the engine's own companions (the CJK *rom.dll romanizers) resolve from the
 *     bundle directory rather than the process's cwd. We likewise never
 *     FreeLibrary, for symmetry and because there is nothing to gain from it in
 *     a one-shot process.
 *
 * Note the entry points are __stdcall on Windows and cdecl elsewhere; the
 * ECI_CALL macro in eci.h carries that, and the whole EciApi table is declared
 * with it.
 *
 * Copyright (C) 2026 Mudb0y / Stas Przecinek
 */

#include "runtime.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#  include <windows.h>
#else
#  include <dlfcn.h>
#endif

/* ---- Platform shims: open a shared library, resolve a symbol, describe an
 * error. Everything below this block is platform-independent. ---- */

#ifdef _WIN32

typedef HMODULE lib_handle;

static lib_handle lib_open(const char *path) {
    /* ALTERED_SEARCH_PATH makes the DLL's own directory part of the search
     * order for its dependencies, which is what we want for a self-contained
     * bundle. Requires an absolute path -- the caller always passes one. */
    return LoadLibraryExA(path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
}

static void *lib_sym(lib_handle h, const char *name) {
    return (void *)(uintptr_t)GetProcAddress(h, name);
}

static void lib_close(lib_handle h) { FreeLibrary(h); }

/* Last error as text, in a static buffer (single-threaded loader, one use per
 * message). FormatMessage leaves a trailing CRLF; trim it. */
static const char *lib_error(void) {
    static char buf[512];
    DWORD e = GetLastError();
    DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                             NULL, e, 0, buf, (DWORD)sizeof(buf) - 1, NULL);
    if (n == 0) {
        snprintf(buf, sizeof(buf), "error %lu", (unsigned long)e);
        return buf;
    }
    while (n > 0 && (buf[n - 1] == '\r' || buf[n - 1] == '\n' || buf[n - 1] == ' ')) buf[--n] = 0;
    return buf;
}

#else

typedef void *lib_handle;

static lib_handle lib_open(const char *path) {
    return dlopen(path, RTLD_NOW | RTLD_GLOBAL);
}
static void *lib_sym(lib_handle h, const char *name) { return dlsym(h, name); }
static void lib_close(lib_handle h) { dlclose(h); }
static const char *lib_error(void) {
    const char *e = dlerror();
    return e ? e : "unknown error";
}

#endif

static lib_handle g_handle = NULL;

/* Resolve a required entry point; bail out of eci_runtime_open if it's absent. */
#define LOAD(name)                                                          \
    do {                                                                    \
        void *sym = lib_sym(g_handle, "eci" #name);                         \
        if (!sym) {                                                         \
            if (errmsg) {                                                   \
                char buf[512];                                              \
                snprintf(buf, sizeof(buf),                                  \
                         "eci_runtime_open: eci" #name " not found: %s",    \
                         lib_error());                                      \
                *errmsg = strdup(buf);                                      \
            }                                                               \
            lib_close(g_handle);                                            \
            g_handle = NULL;                                                \
            return -1;                                                      \
        }                                                                   \
        api->name = sym;                                                    \
    } while (0)

/* Resolve an optional entry point, leaving the slot NULL when the runtime
 * doesn't have it. Callers must null-check before use. */
#define LOAD_OPT(name)                                                      \
    do {                                                                    \
        api->name = lib_sym(g_handle, "eci" #name);                         \
    } while (0)

int eci_runtime_open(const char *eci_lib_path, EciApi *api, char **errmsg) {
    if (g_handle) {
        if (errmsg) *errmsg = strdup("eci_runtime_open: already loaded");
        return -1;
    }
    memset(api, 0, sizeof(*api));

    g_handle = lib_open(eci_lib_path);
    if (!g_handle) {
        if (errmsg) {
            char buf[1024];
            snprintf(buf, sizeof(buf), "cannot load %s: %s", eci_lib_path, lib_error());
            *errmsg = strdup(buf);
        }
        return -1;
    }

    /* Resolve every IBM-documented entry point. If any are missing, the
     * runtime doesn't conform to the IBM ABI and we refuse to load. */

    /* Lifecycle */
    LOAD(New);
    LOAD(NewEx);
    LOAD(Delete);
    LOAD(Reset);
    LOAD(IsBeingReentered);
    LOAD(Version);

    /* Diagnostics */
    LOAD(ProgStatus);
    LOAD(ErrorMessage);
    LOAD(ClearErrors);
    LOAD(TestPhrase);

    /* Single-shot speak */
    LOAD(SpeakText);
    LOAD(SpeakTextEx);

    /* Parameters. The Get/SetDefaultParam pair is documented by IBM but is NOT
     * exported by the Windows ECI.DLL (verified against its export table), and
     * nothing here calls it -- so it is optional rather than a hard failure
     * that would reject an otherwise perfectly good runtime. */
    LOAD(GetParam);
    LOAD(SetParam);
    LOAD_OPT(GetDefaultParam);
    LOAD_OPT(SetDefaultParam);

    /* Voices */
    LOAD(CopyVoice);
    LOAD(GetVoiceName);
    LOAD(SetVoiceName);
    LOAD(GetVoiceParam);
    LOAD(SetVoiceParam);

    /* Synthesis queue */
    LOAD(AddText);
    LOAD(InsertIndex);
    LOAD(Synthesize);
    LOAD(SynthesizeFile);
    LOAD(ClearInput);
    LOAD(GeneratePhonemes);
    LOAD(GetIndex);

    /* Playback control */
    LOAD(Stop);
    LOAD(Speaking);
    LOAD(Synchronize);
    LOAD(Pause);

    /* Output routing */
    LOAD(SetOutputBuffer);
    LOAD(SetOutputFilename);
    LOAD(SetOutputDevice);

    /* Callbacks */
    LOAD(RegisterCallback);

    /* Languages */
    LOAD(GetAvailableLanguages);

    /* Dictionaries */
    LOAD(NewDict);
    LOAD(GetDict);
    LOAD(SetDict);
    LOAD(DeleteDict);
    LOAD(LoadDict);

    return 0;
}

void eci_runtime_close(void) {
    /* See file header: we deliberately leave the library mapped. */
    g_handle = NULL;
}
